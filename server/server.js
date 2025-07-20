const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const PipeServer = require('./pipeServer');
const BotManager = require('./botManager');
const sandboxManager = require('./sandboxManager');
const { state, BotStatus } = require('../shared/state');
const { exec } = require('child_process');

class neptunePanelServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = socketIo(this.server);
        this.pipeServer = null;
        this.botManager = null;
        this.port = process.env.PORT || 3000;
        
        this.pendingStatusUpdates = {};
        this.statusUpdateTimer = null;
        this.statusUpdateInterval = 250;
        this.highLoadThreshold = 20;
        
        this.setupExpress();
        this.setupSocketIO();
        this.setupPipeServer();
        this.setupBotManager();
        this.setupProcessHandlers();
    }
    
    setupExpress() {
        this.app.use(express.static(path.join(__dirname, '../public')));
        this.app.use(express.json());
        this.setupApiRoutes();
    }
    
    setupApiRoutes() {
        this.app.get('/api/status', (req, res) => {
            const botStatuses = {};
            const now = Date.now();
            for (const botNumber of this.getAllKnownBots()) {
                const currentStatus = state.botStatuses[botNumber];
                const lastHeartbeatTime = state.lastHeartbeats[botNumber] || null;
                const heartbeatData = lastHeartbeatTime ? {
                    timestamp: lastHeartbeatTime,
                    secondsAgo: Math.floor((now - lastHeartbeatTime) / 1000)
                } : null;
                botStatuses[botNumber] = {
                    status: currentStatus || BotStatus.NOT_STARTED,
                    pipeStatus: state.pipeStatuses[botNumber] || 'Disconnected',
                    lastHeartbeat: heartbeatData,
                    active: state.activeBots.has(botNumber) || (currentStatus && currentStatus !== BotStatus.NOT_STARTED && currentStatus !== BotStatus.STOPPED),
                    starting: state.botsStarting.has(botNumber),
                    isRestarting: state.restartingBots.has(botNumber)
                };
            }
            res.json({
                botsActive: state.activeBots.size,
                botsStarting: state.botsStarting.size,
                quotaTotal: state.config.botQuota,
                quotaUsed: state.getTotalActiveBots(),
                autoRestartEnabled: state.autoRestartEnabled,
                botStatuses
            });
        });
        
        this.app.post('/api/bot/:botNumber/start', (req, res) => {
            const botNumber = parseInt(req.params.botNumber);
            if (isNaN(botNumber) || botNumber < 0 || botNumber > 99) {
                return res.status(400).json({ error: 'Invalid bot number' });
            }
            const result = this.botManager.queueBot(botNumber);
            if (result) {
                res.json({ success: true, message: `Bot ${botNumber} queued for startup` });
            } else {
                res.status(400).json({ 
                    success: false, 
                    message: `Bot ${botNumber} could not be queued. It may already be active or queued.` 
                });
            }
        });
        
        this.app.post('/api/bot/:botNumber/stop', (req, res) => {
            const botNumber = parseInt(req.params.botNumber);
            if (isNaN(botNumber) || botNumber < 0 || botNumber > 99) {
                return res.status(400).json({ error: 'Invalid bot number' });
            }
            const result = this.botManager.stopBot(botNumber);
            if (result) {
                res.json({ success: true, message: `Bot ${botNumber} stopped` });
            } else {
                res.status(400).json({ 
                    success: false, 
                    message: `Bot ${botNumber} could not be stopped. It may not be active.` 
                });
            }
        });
        
        this.app.post('/api/bot/:botNumber/restart', (req, res) => {
            const botNumber = parseInt(req.params.botNumber);
            if (isNaN(botNumber) || botNumber < 0 || botNumber > 99) {
                return res.status(400).json({ error: 'Invalid bot number' });
            }
            const result = this.botManager.restartBot(botNumber);
            if (result) {
                res.json({ success: true, message: `Bot ${botNumber} restarting` });
            } else {
                res.status(400).json({ 
                    success: false, 
                    message: `Bot ${botNumber} could not be restarted` 
                });
            }
        });
        
        this.app.post('/api/bot/:botNumber/command', (req, res) => {
            const botNumber = parseInt(req.params.botNumber);
            const { command } = req.body;
            if (isNaN(botNumber) || botNumber < 0 || botNumber > 99) {
                return res.status(400).json({ error: 'Invalid bot number' });
            }
            if (!command) {
                return res.status(400).json({ error: 'Command is required' });
            }
            const result = this.botManager.sendCommand(botNumber, command);
            if (result) {
                res.json({ success: true, message: `Command sent to bot ${botNumber}` });
            } else {
                res.status(400).json({ 
                    success: false, 
                    message: `Could not send command to bot ${botNumber}. It may not be connected.` 
                });
            }
        });
        
        this.app.post('/api/auto-restart/toggle', (req, res) => {
            const { enabled } = req.body;
            if (typeof enabled !== 'boolean') {
                return res.status(400).json({ error: 'Enabled parameter must be a boolean' });
            }
            sandboxManager.toggleAutoRestart(enabled);
            res.json({ 
                success: true, 
                message: `Auto-restart ${enabled ? 'enabled' : 'disabled'}`,
                autoRestartEnabled: state.autoRestartEnabled
            });
        });
        
        this.app.get('/api/auto-restart/status', (req, res) => {
            res.json({
                autoRestartEnabled: state.autoRestartEnabled,
                restartingBots: Array.from(state.restartingBots)
            });
        });
        
        this.app.get('/api/settings', (req, res) => {
            res.json(state.config);
        });
        
        this.app.post('/api/settings', (req, res) => {
            const newSettings = req.body;
            if (typeof newSettings.maxConcurrentStarts !== 'undefined') {
                state.config.maxConcurrentStarts = parseInt(newSettings.maxConcurrentStarts);
            }
            if (typeof newSettings.botQuota !== 'undefined') {
                state.config.botQuota = parseInt(newSettings.botQuota);
            }
            if (typeof newSettings.tf2StartDelay !== 'undefined') {
                state.config.tf2StartDelay = parseInt(newSettings.tf2StartDelay);
            }
            if (typeof newSettings.injectDelay !== 'undefined') {
                state.config.injectDelay = parseInt(newSettings.injectDelay);
            }
            if (typeof newSettings.enableTextmodeDelay !== 'undefined') {
                state.config.enableTextmodeDelay = Boolean(newSettings.enableTextmodeDelay);
            }
            if (typeof newSettings.textmodeDelay !== 'undefined') {
                state.config.textmodeDelay = parseFloat(newSettings.textmodeDelay);
            }
            if (typeof newSettings.sandboxiePath !== 'undefined') {
                state.config.sandboxiePath = newSettings.sandboxiePath;
            }
            if (typeof newSettings.steamPath !== 'undefined') {
                state.config.steamPath = newSettings.steamPath;
            }
            if (typeof newSettings.tf2Path !== 'undefined') {
                state.config.tf2Path = newSettings.tf2Path;
            }
            if (typeof newSettings.pipeName !== 'undefined') {
                state.config.pipeName = newSettings.pipeName;
            }
            state.saveConfig();
            res.json({ success: true, message: 'Settings updated', settings: state.config });
        });
    }
    
    sendThrottledStatusUpdate(botNumber, statusData) {
        if (statusData.lastHeartbeat && typeof statusData.lastHeartbeat === 'number') {
            statusData.lastHeartbeat = {
                timestamp: statusData.lastHeartbeat,
                secondsAgo: Math.floor((Date.now() - statusData.lastHeartbeat) / 1000)
            };
        }
        this.pendingStatusUpdates[botNumber] = statusData;
        const activeBotCount = state.activeBots.size + state.botsStarting.size;
        const shouldThrottle = activeBotCount >= this.highLoadThreshold;
        if (!shouldThrottle || !this.statusUpdateTimer) {
            if (!shouldThrottle) {
                this.io.emit('statusUpdate', {
                    autoRestartEnabled: state.autoRestartEnabled,
                    botStatuses: {
                        [botNumber]: statusData
                    }
                });
                delete this.pendingStatusUpdates[botNumber];
                return;
            }
            this.statusUpdateTimer = setTimeout(() => {
                this.flushStatusUpdates();
            }, this.statusUpdateInterval);
        }
    }
    
    flushStatusUpdates() {
        this.statusUpdateTimer = null;
        if (Object.keys(this.pendingStatusUpdates).length === 0) {
            return;
        }
        const now = Date.now();
        for (const botNumber in this.pendingStatusUpdates) {
            const statusData = this.pendingStatusUpdates[botNumber];
            if (statusData.lastHeartbeat && statusData.lastHeartbeat.timestamp) {
                statusData.lastHeartbeat.secondsAgo = Math.floor((now - statusData.lastHeartbeat.timestamp) / 1000);
            }
        }
        this.io.emit('statusUpdate', {
            autoRestartEnabled: state.autoRestartEnabled,
            botStatuses: this.pendingStatusUpdates
        });
        this.pendingStatusUpdates = {};
    }
    
    setupSocketIO() {
        const originalEmit = this.io.emit;
        this.io.emit = (event, ...args) => {
            if (event === 'statusUpdate' && args.length > 0) {
                const data = args[0];
                if (data.botNumber !== undefined) {
                    const botNumber = data.botNumber;
                    const statusData = {
                        status: data.status,
                        pipeStatus: data.pipeStatus,
                        lastHeartbeat: data.lastHeartbeat,
                        active: state.activeBots.has(botNumber),
                        starting: state.botsStarting.has(botNumber),
                        isRestarting: state.restartingBots.has(botNumber)
                    };
                    this.sendThrottledStatusUpdate(botNumber, statusData);
                    return;
                }
            }
            return originalEmit.apply(this.io, [event, ...args]);
        };
        
        this.io.on('connection', (socket) => {
            logger.info('Client connected');
            this.sendInitialState(socket);
            socket.on('startBot', (botNumber) => {
                botNumber = parseInt(botNumber);
                if (!isNaN(botNumber)) {
                    this.botManager.queueBot(botNumber);
                }
            });
            socket.on('stopBot', (botNumber) => {
                botNumber = parseInt(botNumber);
                if (!isNaN(botNumber)) {
                    this.botManager.stopBot(botNumber);
                }
            });
            socket.on('restartBot', (botNumber) => {
                botNumber = parseInt(botNumber);
                if (!isNaN(botNumber)) {
                    this.botManager.restartBot(botNumber);
                }
            });
            socket.on('sendCommand', ({ botNumber, command }) => {
                botNumber = parseInt(botNumber);
                if (!isNaN(botNumber) && command) {
                    this.botManager.sendCommand(botNumber, command);
                }
            });
            socket.on('sendCommandToAllBots', ({ command }) => {
                if (command) {
                    this.botManager.sendCommandToAllBots(command);
                }
            });
            socket.on('stopAllBots', async () => {
                logger.info('Stopping all bots requested by client');
                try {
                    this.io.emit('logMessage', 'Stopping all bots and terminating processes...');
                    await this.botManager.stopAllBots();
                    this.io.emit('logMessage', 'Performing sandbox cleanup...');
                    try {
                        const botNumbers = Array.from(state.sandboxes.keys());
                        for (const botNumber of botNumbers) {
                            const sandboxName = state.sandboxes.get(botNumber);
                            if (sandboxName) {
                                const finishCleanup = async () => {
                                    try {
                                        await new Promise(resolve => setTimeout(resolve, 1000));
                                        const sandboxiePath = state.config.sandboxiePath;
                                        const killCmd = `"${sandboxiePath}" /box:${sandboxName} cmd /c "taskkill /F /T /IM *.*"`;
                                        exec(killCmd);
                                    } catch (err) {
                                        logger.error(`Final cleanup error for ${sandboxName}: ${err.message}`);
                                    }
                                };
                                finishCleanup();
                            }
                        }
                    } catch (cleanupErr) {
                        logger.error(`Error during sandbox cleanup: ${cleanupErr.message}`);
                    }
                    this.io.emit('logMessage', 'All bots stopped successfully');
                } catch (err) {
                    logger.error(`Error in stopAllBots handler: ${err.message}`);
                    this.io.emit('logMessage', `Error stopping all bots: ${err.message}`);
                }
            });
            socket.on('toggleAutoRestart', (enabled) => {
                if (typeof enabled === 'boolean') {
                    sandboxManager.toggleAutoRestart(enabled);
                    this.io.emit('autoRestartState', {
                        enabled: state.autoRestartEnabled,
                        restartingBots: Array.from(state.restartingBots)
                    });
                }
            });
            socket.on('disconnect', () => {
                logger.info('Client disconnected');
            });
        });
    }
    
    sendInitialState(socket) {
        const botStatuses = {};
        const now = Date.now();
        for (const botNumber of this.getAllKnownBots()) {
            const currentStatus = state.botStatuses[botNumber];
            const lastHeartbeatTime = state.lastHeartbeats[botNumber] || null;
            const heartbeatData = lastHeartbeatTime ? {
                timestamp: lastHeartbeatTime,
                secondsAgo: Math.floor((now - lastHeartbeatTime) / 1000)
            } : null;
            botStatuses[botNumber] = {
                status: currentStatus || BotStatus.NOT_STARTED,
                pipeStatus: state.pipeStatuses[botNumber] || 'Disconnected',
                lastHeartbeat: heartbeatData,
                active: state.activeBots.has(botNumber) || (currentStatus && currentStatus !== BotStatus.NOT_STARTED && currentStatus !== BotStatus.STOPPED),
                starting: state.botsStarting.has(botNumber),
                isRestarting: state.restartingBots.has(botNumber)
            };
        }
        socket.emit('statusUpdate', {
            autoRestartEnabled: state.autoRestartEnabled,
            botStatuses: botStatuses
        });
        socket.emit('queueUpdate', {
            currentlyStarting: Array.from(state.botsStarting),
            inQueue: this.botManager ? this.botManager.botProcessQueue : []
        });
        socket.emit('quotaUpdate', {
            current: state.getTotalActiveBots(),
            total: state.config.botQuota
        });
        socket.emit('autoRestartState', {
            enabled: state.autoRestartEnabled,
            restartingBots: Array.from(state.restartingBots)
        });
        socket.emit('settingsUpdate', state.config);
        logger.info('Sent initial state to client');
    }
    
    getAllKnownBots() {
        const allBotNumbers = new Set();
        Object.keys(state.botStatuses).forEach(botNum => {
            allBotNumbers.add(parseInt(botNum));
        });
        state.activeBots.forEach(botNum => {
            allBotNumbers.add(botNum);
        });
        state.botsStarting.forEach(botNum => {
            allBotNumbers.add(botNum);
        });
        state.pipeConnections.forEach((_, botNum) => {
            allBotNumbers.add(botNum);
        });
        return Array.from(allBotNumbers);
    }
    
    setupPipeServer() {
        this.pipeServer = new PipeServer(this.io);
        this.pipeServer.start();
        logger.info('Pipe server initialized');
    }
    
    setupBotManager() {
        try {
            this.botManager = require('./botManager');
            this.botManager.setIO(this.io);
            if (this.pipeServer) {
                this.botManager.setPipeServer(this.pipeServer);
            }
            this.botManager.initialize();
            sandboxManager.setIO(this.io);
            logger.info('Bot manager initialized');
        } catch (error) {
            logger.error(`Failed to initialize BotManager: ${error.message}`);
            console.error(error);
        }
    }
    
    setupProcessHandlers() {
        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());
        process.on('uncaughtException', (error) => {
            logger.error(`Uncaught Exception: ${error.message}`);
            console.error(error);
        });
        process.on('unhandledRejection', (reason, promise) => {
            logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
            console.error(reason);
        });
    }
    
    start() {
        this.server.listen(this.port, () => {
            logger.info(`neptune Panel Server running on port ${this.port}`);
            console.log(`neptune Panel Server running on port ${this.port}`);
        });
    }
    
    async shutdown() {
        logger.info('Server shutting down...');
        if (this.botManager) {
            try {
                await this.botManager.cleanup();
                logger.info('Bot cleanup completed during shutdown');
            } catch (err) {
                logger.error(`Error during bot cleanup: ${err.message}`);
            }
        }
        this.server.close(() => {
            logger.info('HTTP server closed');
            process.exit(0);
        });
        setTimeout(() => {
            logger.error('Forced shutdown after timeout');
            process.exit(1);
        }, 5000);
    }
}

const server = new neptunePanelServer();
server.start(); 