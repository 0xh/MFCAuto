var EventEmitter: any = require('events').EventEmitter;

//Creates and maintains a TCP socket connection to MFC chat servers similar to
//the way the Flash client connects and communicates with MFC.
class Client implements NodeJS.EventEmitter {
    sessionId: number;
    username: string;
    password: string;
    uid: number;

    private net: any;
    private debug: boolean = false; //Set to true to enable debug logging
    private serverConfig: ServerConfig;
    private streamBuffer: Buffer;
    private streamBufferPosition: number;
    private emoteParser: EmoteParser;
    private client: any;
    private keepAlive: NodeJS.Timer;

    //By default, this client will log in as a guest.
    //
    //To log in with a real account you specify your username as normal text.
    //The password should be a hash of your real password and NOT your actual
    //plain text password.  I have not determined how the passwords are hashed
    //but you can discover the appropriate string to use by checking your browser
    //cookies after logging in via your browser.  In Firefox, go to Options->Privacy
    //and then "Show Cookies..." and search for "myfreecams".  You will see one
    //cookie named "passcode".  Select it and copy the value listed as "Content".
    //It will be a long string of lower case letters that looks like gibberish.
    //*That* is the password to use here.
    constructor(username: string = "guest", password: string = "guest") {
        this.net = require('net');
        this.username = username;
        this.password = password;
        this.sessionId = 0;
        this.streamBuffer = new Buffer(0);
        this.streamBufferPosition = 0;
    }

    //Instance EventEmitter methods
    addListener: (event: string, listener: Function) => NodeJS.EventEmitter;
    on: (event: string, listener: Function) => NodeJS.EventEmitter;
    once: (event: string, listener: Function) => NodeJS.EventEmitter;
    removeListener: (event: string, listener: Function) => NodeJS.EventEmitter;
    removeAllListeners: (event?: string) => NodeJS.EventEmitter;
    setMaxListeners: (n: number) => void;
    listeners: (event: string) => Function[];
    emit: (event: string, ...args: any[]) => boolean;

    //Simple helper log function that adds a timestamp and supports filtering 'debug' only messages
    private log(msg: string, debugOnly: boolean = false): void {
        if (debugOnly && !this.debug) {
            return;
        }
        log(msg);
    }

    /*Reads data from the socket as quickly as possible and stores it in an internal buffer
    readData is invoked by the "on data" event of the net.client object currently handling
    the TCP connection to the MFC servers.

    This is an internal method, don't call it directly.*/
    private _readData(buf: Buffer): void {
        this.streamBuffer = Buffer.concat([this.streamBuffer, buf]);

        //The new buffer might contain a complete packet, try to read to find out...
        this._readPacket();
    }

    /*Called with a single, complete, packet.  This function processes the packet,
    handling some special packets like FCTYPE_LOGIN, which gives our user name and
    session ID when first logging in to mfc.  It then calls out to any registered
    event handlers.

    This is an internal method, don't call it directly.*/
    private _packetReceived(packet: Packet): void {
        this.log(packet.toString(), true);

        //Special case handling the login packet that gives your username and session ID
        if (packet.FCType === FCTYPE.LOGIN) {
            if (packet.nArg1 !== 0) {
                this.log("Login failed for user '" + this.username + "' password '" + this.password + "'");
                throw new Error("Login failed");
            } else {
                this.sessionId = packet.nTo;
                this.uid = packet.nArg2;
                this.username = <string>packet.sMessage;
                this.log("Login handshake completed. Logged in as '" + this.username + "' with sessionId " + this.sessionId);
            }
        }

        //Another special case for sessionstate updates, update our global user status tracking
        if (packet.FCType === FCTYPE.SESSIONSTATE) {
            var id = packet.nArg2; //For SESSIONSTATE, nArg2 is the model id
            var payload = packet.sMessage;

            Model.getModel(id).mergePacket(packet);
        }
        //And the same for tags updates
        if (packet.FCType === FCTYPE.TAGS) {
            var tagPayload: any = packet.sMessage;
            for (var key in tagPayload) {
                if (tagPayload.hasOwnProperty(key)) {
                    Model.getModel(key).mergePacket(packet);
                }
            }
        }

        //Fire this packet's event for any listeners
        this.emit(FCTYPE[packet.FCType], packet);
        this.emit(FCTYPE[FCTYPE.ANY], packet);
    }

    /*Parses the MFC stream buffer, for each complete individual packet
    it receives, it will call packetReceived.  Because of the single-threaded async nature of node.js, there will often be
    partial packets and need to handle that gracefully, only calling packetReceived once
    we've parsed out a complete response...

    This is an internal method, don't call it directly.*/
    private _readPacket(): void {
        var pos: number = this.streamBufferPosition;
        var intParams: number[] = [];
        var strParam: string;

        try {
            //Each incoming packet is initially tagged with 7 int32 values, they look like this:
            // 0 = "Magic" value that is *always* -2027771214
            // 1 = "FCType" that identifies the type of packet this is (FCType being a MyFreeCams defined thing)
            // 2 = nFrom
            // 3 = nTo
            // 4 = nArg1
            // 5 = nArg2
            // 6 = sPayload, the size of the payload
            // 7 = sMessage, the actual payload.  This is not an int but is the actual buffer

            //Any read here could throw a RangeError exception for reading beyond the end of the buffer.  In theory we could handle this
            //better by checking the length before each read, but that would be a bit ugly.  Instead we handle the RangeErrors and just
            //try to read again the next time the buffer grows and we have more data


            //Parse out the first 7 integer parameters (Magic, FCType, nFrom, nTo, nArg1, nArg2, sPayload)
            for (var i = 0; i < 7; i++) {
                intParams.push(this.streamBuffer.readInt32BE(pos));
                pos += 4;
            }
            //If the first integer is MAGIC, we have a valid packet
            if (intParams[0] === MAGIC) {
                //If there is a JSON payload to this packet
                if (intParams[6] > 0) {
                    //If we don't have the complete payload in the buffer already, bail out and retry after we get more data from the network
                    if (pos + intParams[6] > this.streamBuffer.length) {
                        throw new RangeError(); //This is needed because streamBuffer.toString will not throw a rangeerror when the last param is out of the end of the buffer
                    }
                    //We have the full packet, store it and move our buffer pointer to the next packet
                    strParam = this.streamBuffer.toString('utf8', pos, pos + intParams[6]);
                    pos = pos + intParams[6];
                }
            } else {
                //Magic value did not match?  In that case, all bets are off.  We no longer understand the MFC stream and cannot recover...
                //This is usually caused by a mis-alignment error due to incorrect buffer management (bugs in this code or the code that writes the buffer from the network)
                throw new Error("Invalid packet received! - " + intParams[0] + " Length == " + this.streamBuffer.length);
            }

            //At this point we have the full packet in the intParams and strParam values, but intParams is an unstructured array
            //Let's clean it up before we delegate to this.packetReceived.  (Leaving off the magic int, because it MUST be there always
            //and doesn't add anything to the understanding)
            var strParam2: AnyMessage;
            if (strParam) {
                try {
                    strParam2 = JSON.parse(strParam);
                } catch (e) {
                    strParam2 = strParam;
                }
            }
            this._packetReceived(new Packet(
                this, //Packet needs to look up certain values in the Client object instance
                intParams[1], //FCType
                intParams[2], //nFrom
                intParams[3], //nTo
                intParams[4], //nArg1
                intParams[5], //nArg2
                intParams[6], //sPayload
                strParam2 //sMessage
                ));

            //If there's more to read, keep reading (which would be the case if the network sent >1 complete packet in a single transmission)
            if (pos < this.streamBuffer.length) {
                this.streamBufferPosition = pos;
                this._readPacket();
            } else {
                //We read the full buffer, clear the buffer cache so that we can
                //read cleanly from the beginning next time (and save memory)
                this.streamBuffer = new Buffer(0);
                this.streamBufferPosition = 0;
            }
        } catch (e) {
            //RangeErrors are expected because sometimes the buffer isn't complete.  Other errors are not...
            if (e.toString().indexOf("RangeError") !== 0) {
                throw e;
            } else {
                // this.log("Expected exception (?): " + e);
            }
        }
    }

    //Takes an input chat string as you would type it in browser in an MFC
    //chat room, like "I am happy :mhappy", and formats the message as MFC
    //would internally before sending it to the server, "I am happy #~ue,2c9d2da6.gif,mhappy~#"
    //in the given example.
    //
    //On the MFC site, this code is part of the ParseEmoteInput function in
    //http://www.myfreecams.com/mfc2/lib/mfccore.js, and it is especially convoluted
    //code involving ajax requests back to the server depending on the text you're
    //sending and a giant hashtable of known emotes.
    //
    //Note that if the text you want to send does not have any emotes, you can
    //directly use TxCmd with the raw string (or possibly the escape(string) but
    //that's easy enough)
    EncodeRawChat(rawMsg: string, callback: EmoteParserCallback): void {
        if (rawMsg.match(/^ *$/)) {
            callback(rawMsg, null);
            return;
        }

        rawMsg = rawMsg.replace(/`/g, "'");
        rawMsg = rawMsg.replace(/<~/g, "'");
        rawMsg = rawMsg.replace(/~>/g, "'");
        this.ensureEmoteParserIsLoaded(function(msg: string, cb: EmoteParserCallback) {
            this.emoteParser.Process(msg, cb);
        }.bind(this, rawMsg, callback));
    }

    //Dynamically loads script code from MFC, massaging it with the given massager
    //function first, and then passed the resulting instantiated object to the
    //given callback.
    //
    //We try to use this sparingly as it opens us up to breaks from site changes.
    //But it is still useful for the more complex or frequently updated parts
    //of MFC.
    private loadFromMFC(url: string, callback: (err: any, obj: any) => void, massager?: (src: string) => string): void {
        var http: any = require('http');
        var load: any = require('load');
        http.get(url, function(res: any) {
            var contents = '';
            res.on('data', function(chunk: string) {
                contents += chunk;
            });
            res.on('end', function() {
                try {
                    if (massager !== undefined) {
                        contents = massager(contents);
                    }
                    var mfcModule = load.compiler(contents)
                    callback(undefined, mfcModule);
                } catch (e) {
                    callback(e, undefined);
                }
            });
        }).on('error', function(e: any) {
            throw new Error("loadFromMFC error while loading '" + url + "' : " + e);
        });
    }

    //Loads the emote parsing code from the MFC web site directly, if it's not
    //already loaded, and then invokes the given callback.  This is useful because
    //most scripts won't actually need the emote parsing capabilities, so lazy
    //loading it can speed up the common case.
    //
    //We're loading this code from the live site instead of re-coding it ourselves
    //here because of the complexity of the code and the fact that it has changed
    //several times in the past.
    private ensureEmoteParserIsLoaded(callback: () => void): void {
        if (this.emoteParser !== undefined) {
            callback();
        } else {
            this.loadFromMFC("http://www.myfreecams.com/mfc2/lib/mfccore.js", function(err: any, obj: any) {
                if (err) throw err;
                this.emoteParser = new obj.ParseEmoteInput();
                callback();
            }.bind(this),
                function(content) {
                    //Massager....Yes this is vulnerable to site breaks, but then
                    //so is this entire module.

                    //First, pull out only the ParseEmoteInput function
                    var startIndex = content.indexOf("function ParseEmoteInput()");
                    var endIndex = content.indexOf("function ParseEmoteOutput()");
                    console.assert(startIndex !== -1 && endIndex !== -1 && startIndex < endIndex, "mfccore.js layout has changed, don't know what to do now");
                    content = content.substr(startIndex, endIndex - startIndex);

                    //Then massage the function somewhat and prepend some prerequisites
                    content = "var document = {location: {protocol: 'file:'}};var XMLHttpRequest = require('XMLHttpRequest').XMLHttpRequest;function bind(that,f){return f.bind(that);}" + content.replace(/createRequestObject\(\)/g, "new XMLHttpRequest()").replace(/new MfcImageHost\(\)/g, "{host: function(){return '';}}").replace(/this\.Reset\(\);/g, "this.Reset();this.oReq = new XMLHttpRequest();");
                    return content;
                });
        }
    }

    //Loads the lastest server information from MFC, if it's not already loaded
    private ensureServerConfigIsLoaded(callback: () => void): void {
        if (this.serverConfig !== undefined) {
            callback();
        } else {
            this.loadFromMFC("http://www.myfreecams.com/mfc2/data/serverconfig.js", function(err: any, obj: any) {
                if (err) throw err;
                this.serverConfig = obj.serverConfig;
                callback();
            }.bind(this), function(text) {
                    return "var serverConfig = " + text;
                });
        }
    }

    //Sends a message back to MFC in the expected packet format
    //usually nTo==0, nArg1==0, nArg2==0, sMsg==null
    //@TODO - Should this use the Packet class instead or as an overload?
    TxCmd(nType: FCTYPE, nTo: number = 0, nArg1: number = 0, nArg2: number = 0, sMsg: string = null): void {
        this.log("TxCmd Sending - nType: " + nType + ", nTo: " + nTo + ", nArg1: " + nArg1 + ", nArg2: " + nArg2 + ", sMsg:" + sMsg, true);
        if (nType === FCTYPE.CMESG || nType === FCTYPE.PMESG) {
            if (sMsg.match(/([\u0000-\u001f\u0022-\u0026\u0080-\uffff]+)/)) sMsg = escape(sMsg).replace(/%20/g, " ");
        }

        var msgLength = (sMsg ? sMsg.length : 0);
        var buf = new Buffer((7 * 4) + msgLength);

        buf.writeInt32BE(MAGIC, 0);
        buf.writeInt32BE(nType, 4);
        buf.writeInt32BE(this.sessionId, 8); //Session id, this is always our nFrom value
        buf.writeInt32BE(nTo, 12);
        buf.writeInt32BE(nArg1, 16);
        buf.writeInt32BE(nArg2, 20);
        buf.writeInt32BE(msgLength, 24);

        if (sMsg) {
            buf.write(sMsg, 28);
        }

        this.client.write(buf);
    }

    //Send msg to the given model's chat room.  Set format to true
    //if this message contains any emotes.  Otherwise, you can save
    //considerable processing time by leaving it false and sending the
    //raw string.
    //
    //Note that you must have previously joined the model's chat room
    //for the message to be sent successfully.
    //
    //Also note, this method has no callback currently, and your message
    //may fail to be sent successfully if you are muted or ignored by
    //the model.
    sendChat(id: number, msg: string, format: boolean = false): void {
        if (format === true) {
            this.EncodeRawChat(msg, function(parsedMsg: string) {
                this.sendChat(id, parsedMsg, false);
            }.bind(this));
        } else {
            //Convert a user ID to the corresponding room ID (unless it's already a room ID)
            if (id < 100000000) {
                id = id + 100000000;
            }
            this.TxCmd(FCTYPE.CMESG, id, 0, 0, msg);
        }
    }

    //Send msg to the given model via PM.  Set format to true
    //if this message contains any emotes.  Otherwise, you can save
    //considerable processing time by leaving it false and sending the
    //raw string.
    //
    //Also note, this method has no callback currently, and your message
    //may fail to be sent successfully if you are ignored by the model or
    //do not have PM access (due to being a guest, etc).
    sendPM(id: number, msg: string, format: boolean = false): void {
        if (format === true) {
            this.EncodeRawChat(msg, function(parsedMsg: string) {
                this.sendPM(id, parsedMsg, false);
            }.bind(this));
        } else {
            assert(id < 100000000, "You can't send a PM to a room.  Choose a specific user id.");
            this.TxCmd(FCTYPE.PMESG, id, 0, 0, msg);
        }
    }

    //Joins the chat room of the given model
    joinRoom(id: number): void {
        //Convert a user ID to the corresponding room ID (unless it's already a room ID)
        if (id < 100000000) {
            id = id + 100000000;
        }
        this.TxCmd(FCTYPE.JOINCHAN, 0, id, FCCHAN.JOIN);
    }

    //Leaves the chat room of the given model
    leaveRoom(id: number): void {
        //Convert a user ID to the corresponding room ID (unless it's already a room ID)
        if (id < 100000000) {
            id = id + 100000000;
        }
        this.TxCmd(FCTYPE.JOINCHAN, 0, id, FCCHAN.PART); //@TODO - Confirm that this works, it's not been tested
    }

    //Connects to MFC and optionally logs in with the credentials you supplied when
    //constructing this Client.
    //
    //Logging in is optional because not all queries to the server require you to log in.
    //For instance, MFC servers will respond to a USERNAMELOOKUP request without
    //requiring a login.
    connect(doLogin: boolean = true, onConnect: () => void = undefined): void {
        //Reset any read buffers so we are in a consistent state
        this.streamBuffer = new Buffer(0);
        this.streamBufferPosition = 0;

        this.ensureServerConfigIsLoaded(function() {
            var chatServer = this.serverConfig.chat_servers[Math.floor(Math.random() * this.serverConfig.chat_servers.length)];

            this.log("Connecting to MyFreeCams chat server " + chatServer + "...");
            this.client = this.net.connect(8100, chatServer + ".myfreecams.com", function() { //'connect' listener
                this.client.on('data', function(data: any) {
                    this._readData(data);
                }.bind(this));
                this.client.on('end', function() {
                    this.log('Disconnected from MyFreeCams.  Reconnecting in 30 seconds...'); // Is 30 seconds reasonable?
                    clearInterval(this.keepAlive);
                    setTimeout(this.connect, 30000);
                }.bind(this));

                //Connecting without logging in is the rarer case, so make the default to log in
                if (doLogin) {
                    this.login();
                }

                //Also should make this an optional separate function too (maybe, maybe not)
                this.keepAlive = setInterval(function() { this.TxCmd(FCTYPE.NULL, 0, 0, 0, null); }.bind(this), 120 * 1000);
                if (onConnect !== undefined) {
                    onConnect();
                }
            }.bind(this));

        }.bind(this));
    }

    //@TODO - Do we need a logout method?

    //Logs in to MFC.  This should only be called after Client connect(false);
    //See the comment on Client's constructor for details on the password to use.
    login(username?: string, password?: string): void {
        if (username !== undefined) {
            this.username = username;
        }
        if (password !== undefined) {
            this.password = password;
        }
        this.TxCmd(FCTYPE.LOGIN, 0, 20071025, 0, this.username + ":" + this.password);
    }
}
applyMixins(Client, [EventEmitter]);

type EmoteParserCallback = (parsedString: string, aMsg2: { txt: string; url: string; code: string }[]) => void;
interface EmoteParser {
    Process(msg: string, callback: EmoteParserCallback): void;
}
interface ServerConfig {
    ajax_servers: string[];
    chat_server: string[];
    h5video_servers: { [index: number]: string };
    release: boolean;
    video_servers: string[];
    websocket_servers: { [index: string]: string };
}

exports.Client = Client;
