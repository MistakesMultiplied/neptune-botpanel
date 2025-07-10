const net = require('net');
const { state, BotStatus } = require('../shared/state');
const logger = require('./logger');

class PipeServer {
    constructor(io) {
        this.io = io;
        this.server = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000;
        this.messageQueues = new Map();
        this.drainCallbacks = new Map();
    }

    start() {
        const pipeName = state.config.pipeName;
        
        this.server = net.createServer((stream) => {
            this.handleConnection(stream);
        });

        this.setupServerEventHandlers();
        
        this.server.listen(pipeName, () => {
            logger.info(`Pipe server listening on ${pipeName}`);
            this.io.emit('logMessage', `Pipe server listening on ${pipeName}`);
            this.reconnectAttempts = 0;
        });
    }

    setupServerEventHandlers() {
        this.server.on('error', (err) => {
            logger.error(`Pipe server error: ${err.message}`);
            this.io.emit('logMessage', `Pipe server error: ${err.message}`);
            
            this.closeServer();
            
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                const delayMs = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts);
                this.reconnectAttempts++;
                
                logger.info(`Restarting pipe server in ${delayMs}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
                this.io.emit('logMessage', `Restarting pipe server in ${delayMs}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
                
                setTimeout(() => this.start(), delayMs);
            } else {
                logger.error('Maximum reconnection attempts reached. Please restart the application.');
                this.io.emit('logMessage', 'Maximum reconnection attempts reached. Please restart the application.');
            }
        });
    }

    handleConnection(stream) {
        logger.info('Pipe connection established');
        this.io.emit('logMessage', 'Pipe connection established');

        let botNumber = null;
        let messageBuffer = '';
        
        stream.on('data', (data) => {
            try {
                messageBuffer += data.toString();
                const messages = messageBuffer.split('\n');
                messageBuffer = messages.pop() || '';
                
                for (const message of messages) {
                    if (message.trim() === '') continue;
                    this.processMessage(message, stream, botNumber);
                }
            } catch (err) {
                logger.error(`Error processing pipe message: ${err.message}`);
                this.io.emit('logMessage', `Error processing pipe message: ${err.message}`);
            }
        });

        this.setupStreamEventHandlers(stream);
    }

    processMessage(message, stream, botNumber) {
        logger.debug(`Received data from pipe: ${message}`);
        
        const parts = message.split(':');
        if (parts.length < 2) {
            logger.error(`Malformed message (not enough parts): ${message}`);
            this.io.emit('logMessage', `Malformed message (not enough parts): ${message}`);
            return;
        }
        
        const receivedBotNumberStr = parts[0];
        const messageType = parts[1];
        const messageValue = parts.slice(2).join(':');
        
        const parsedBotNumber = parseInt(receivedBotNumberStr);
        if (isNaN(parsedBotNumber)) {
            logger.error(`Received message with invalid bot number: ${receivedBotNumberStr}`);
            this.io.emit('logMessage', `Received message with invalid bot number: ${receivedBotNumberStr}`);
            return;
        }
        
        if (botNumber === null) {
            botNumber = parsedBotNumber;
            this.registerBot(botNumber, stream);
        }
        
        if (parsedBotNumber === botNumber) {
            this.handleBotMessage(botNumber, messageType, messageValue);
        } else {
            logger.warn(`Received message for bot ${parsedBotNumber} on stream for bot ${botNumber}`);
            this.io.emit('logMessage', `Warning: Received message for bot ${parsedBotNumber} on stream for bot ${botNumber}`);
        }
    }

    registerBot(botNumber, stream) {
        if (state.pipeConnections.has(botNumber) && state.pipeConnections.get(botNumber) !== stream) {
            logger.warn(`Bot ${botNumber} already connected with a different stream. Closing old connection.`);
            this.io.emit('logMessage', `Bot ${botNumber} already connected with a different stream. Closing old connection.`);
            const oldStream = state.pipeConnections.get(botNumber);
            this.closeStream(oldStream);
        }
        
        if (!this.messageQueues.has(botNumber)) {
            this.messageQueues.set(botNumber, []);
        }
        
        stream.on('drain', () => {
            if (this.drainCallbacks.has(botNumber)) {
                const callback = this.drainCallbacks.get(botNumber);
                this.drainCallbacks.delete(botNumber);
                callback();
            }
            this.processMessageQueue(botNumber);
        });
        
        state.pipeConnections.set(botNumber, stream);
        state.botStatuses[botNumber] = BotStatus.CONNECTED;
        state.pipeStatuses[botNumber] = 'Connected';
        state.lastHeartbeats[botNumber] = Date.now();
        
        logger.info(`Bot ${botNumber} registered and connected`);
        this.io.emit('logMessage', `Bot ${botNumber} registered and connected`);
        this.io.emit('statusUpdate', { 
            botNumber, 
            status: BotStatus.CONNECTED, 
            pipeStatus: 'Connected',
            lastHeartbeat: state.lastHeartbeats[botNumber]
        });
    }

    handleBotMessage(botNumber, messageType, messageValue) {
        state.lastHeartbeats[botNumber] = Date.now();
        
        const heartbeatData = {
            timestamp: state.lastHeartbeats[botNumber],
            secondsAgo: 0
        };
        
        logger.debug(`Bot ${botNumber} message: Type='${messageType}', Value='${messageValue}'`);
        
        switch (messageType) {
            case 'Health':
                const healthValue = parseInt(messageValue) || 0;
                this.io.emit('botUpdate', { 
                    botNumber, 
                    health: healthValue, 
                    lastHeartbeat: heartbeatData 
                });
                break;
                
            case 'PlayerClass':
                this.io.emit('botUpdate', { 
                    botNumber, 
                    playerClass: messageValue, 
                    lastHeartbeat: heartbeatData 
                });
                break;
                
            case 'Map':
                this.io.emit('botUpdate', { 
                    botNumber, 
                    map: messageValue, 
                    lastHeartbeat: heartbeatData 
                });
                break;
                
            case 'ServerInfo':
                this.io.emit('botUpdate', { 
                    botNumber, 
                    serverInfo: messageValue, 
                    lastHeartbeat: heartbeatData 
                });
                break;
                
            case 'Status':
                this.io.emit('botUpdate', { 
                    botNumber, 
                    status: messageValue, 
                    lastHeartbeat: heartbeatData 
                });
                break;
                
            case 'CommandResponse':
                logger.info(`Command response from bot ${botNumber}: ${messageValue}`);
                this.io.emit('logMessage', `Command response from bot ${botNumber}: ${messageValue}`);
                break;
                
            case 'LocalBot':
                this.forwardLocalBotMessage(botNumber, messageValue);
                break;
                
            default:
                this.io.emit('botUpdate', { 
                    botNumber, 
                    [messageType.toLowerCase()]: messageValue, 
                    lastHeartbeat: heartbeatData 
                });
        }
        
        this.io.emit('statusUpdate', { 
            botNumber, 
            status: state.botStatuses[botNumber], 
            pipeStatus: 'Connected',
            lastHeartbeat: heartbeatData
        });
    }

    forwardLocalBotMessage(sourceBotNumber, messageValue) {
        if (!messageValue || typeof messageValue !== 'string') {
            logger.error(`Invalid LocalBot message value from bot ${sourceBotNumber}: ${messageValue}`);
            this.io.emit('logMessage', `Invalid LocalBot message value from bot ${sourceBotNumber}`);
            return;
        }
        
        const otherBots = Array.from(state.pipeConnections.entries())
            .filter(([botNum]) => botNum !== sourceBotNumber);
        
        if (otherBots.length === 0) {
            logger.info(`No other bots connected to forward message from bot ${sourceBotNumber}`);
            return;
        }
        
        let successCount = 0;
        let failCount = 0;
        
        for (const [targetBotNumber, targetStream] of otherBots) {
            try {
                if (targetStream && targetStream.writable) {
                    const message = `${sourceBotNumber}:LocalBot:${messageValue}\n`;
                    this.queueMessage(targetBotNumber, message);
                    successCount++;
                } else {
                    failCount++;
                    logger.warn(`Invalid stream for bot ${targetBotNumber}`);
                }
            } catch (err) {
                failCount++;
                logger.error(`Error forwarding to bot ${targetBotNumber}: ${err.message}`);
            }
        }
        
        logger.info(`Bot ${sourceBotNumber} broadcasted ID ${messageValue} (Success: ${successCount}, Failed: ${failCount})`);
        this.io.emit('logMessage', `Bot ${sourceBotNumber} broadcasted its ID: ${messageValue} (Success: ${successCount}, Failed: ${failCount})`);
    }

    setupStreamEventHandlers(stream) {
        stream.on('end', () => this.handleStreamEnd(stream));
        stream.on('error', (err) => this.handleStreamError(stream, err));
        stream.on('close', (hadError) => this.handleStreamClose(stream, hadError));
    }

    handleStreamEnd(stream) {
        const botNumber = this.getBotNumberForStream(stream);
        logger.info(`Pipe connection ended gracefully by Bot ${botNumber !== null ? botNumber : 'unknown'}`);
        this.io.emit('logMessage', `Pipe connection ended gracefully by Bot ${botNumber !== null ? botNumber : 'unknown'}`);
        
        if (botNumber !== null) {
            this.handleDisconnect(botNumber, stream, 'Disconnected');
            
            const reconnectTimeout = setTimeout(() => {
                if (!state.pipeConnections.has(botNumber)) {
                    logger.info(`Bot ${botNumber} did not reconnect within timeout period`);
                    this.io.emit('logMessage', `Bot ${botNumber} did not reconnect within timeout period`);
                }
            }, 30000);
            
            const previousTimer = state.disconnectTimers.get(botNumber);
            if (previousTimer) {
                clearTimeout(previousTimer);
            }
            
            state.disconnectTimers.set(botNumber, reconnectTimeout);
        }
    }

    handleStreamError(stream, err) {
        const botNumber = this.getBotNumberForStream(stream);
        logger.error(`Pipe stream error for Bot ${botNumber !== null ? botNumber : 'unknown'}: ${err.message}`);
        this.io.emit('logMessage', `Pipe stream error for Bot ${botNumber !== null ? botNumber : 'unknown'}: ${err.message}`);
        
        if (botNumber !== null) {
            this.handleDisconnect(botNumber, stream, 'Disconnected (Error)');
            
            const currentStatus = state.botStatuses[botNumber];
            if (currentStatus === BotStatus.CONNECTED || currentStatus === BotStatus.RUNNING || 
                currentStatus === BotStatus.ACTIVE) {
                state.botStatuses[botNumber] = BotStatus.CRASHED;
            }
            
            this.io.emit('statusUpdate', { 
                botNumber, 
                status: state.botStatuses[botNumber], 
                pipeStatus: 'Disconnected (Error)' 
            });
        }
        
        this.closeStream(stream);
    }

    handleStreamClose(stream, hadError) {
        const botNumber = this.getBotNumberForStream(stream);
        logger.info(`Pipe stream closed for Bot ${botNumber !== null ? botNumber : 'unknown'}. Had error: ${hadError}`);
        this.io.emit('logMessage', `Pipe stream closed for Bot ${botNumber !== null ? botNumber : 'unknown'}. Had error: ${hadError}`);
        
        if (botNumber !== null && !hadError) {
            this.handleDisconnect(botNumber, stream, 'Disconnected (Closed)');
        }
    }

    handleDisconnect(botNumber, stream, statusText) {
        if (state.pipeConnections.get(botNumber) === stream) {
            state.pipeConnections.delete(botNumber);
            state.pipeStatuses[botNumber] = statusText;
            
            this.messageQueues.delete(botNumber);
            this.drainCallbacks.delete(botNumber);
            
            this.io.emit('statusUpdate', { 
                botNumber, 
                status: state.botStatuses[botNumber],
                pipeStatus: statusText
            });
            
            logger.info(`Bot ${botNumber} disconnected: ${statusText}`);
        }
    }

    closeStream(stream) {
        if (stream && typeof stream.destroy === 'function') {
            try {
                stream.destroy();
            } catch (err) {
                logger.error(`Error destroying stream: ${err.message}`);
            }
        }
    }

    closeServer() {
        if (this.server) {
            try {
                this.server.close();
            } catch (err) {
                logger.error(`Error closing pipe server: ${err.message}`);
            }
            this.server = null;
        }
    }

    getBotNumberForStream(stream) {
        for (const [botNumber, connectedStream] of state.pipeConnections.entries()) {
            if (connectedStream === stream) {
                return botNumber;
            }
        }
        return null;
    }

    sendCommand(botNumber, command) {
        const stream = state.pipeConnections.get(botNumber);
        if (!stream || !stream.writable) {
            logger.error(`Cannot send command - bot ${botNumber} not connected`);
            return false;
        }
        
        try {
            const message = `${botNumber}:Command:${command}\n`;
            return this.queueMessage(botNumber, message);
        } catch (err) {
            logger.error(`Error sending command to bot ${botNumber}: ${err.message}`);
            return false;
        }
    }

    queueMessage(botNumber, message) {
        if (!this.messageQueues.has(botNumber)) {
            this.messageQueues.set(botNumber, []);
        }
        
        this.messageQueues.get(botNumber).push(message);
        
        return this.processMessageQueue(botNumber);
    }

    processMessageQueue(botNumber) {
        const queue = this.messageQueues.get(botNumber);
        if (!queue || queue.length === 0) {
            return true;
        }
        
        const stream = state.pipeConnections.get(botNumber);
        if (!stream || !stream.writable) {
            logger.error(`Cannot process message queue - bot ${botNumber} not connected`);
            return false;
        }
        
        let success = true;
        while (queue.length > 0) {
            const message = queue[0];
            
            if (stream.write(message)) {
                queue.shift();
            } else {
                success = false;
                
                this.drainCallbacks.set(botNumber, () => {
                    this.processMessageQueue(botNumber);
                });
                
                break;
            }
        }
        
        return success;
    }
}

module.exports = PipeServer;