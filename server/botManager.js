const { exec, spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { state, BotStatus } = require('../shared/state');
const logger = require('./logger');
const instanceManager = require('./instanceManager');

class BotManager {
    constructor(io) {
        this.io = io || null;
        this.botProcessQueue = [];
        this.processInterval = null;
        this.maxConcurrentStarts = state.config.maxConcurrentStarts || 2;
        this.accounts = [];
        this.botStopFlags = new Map();
        this.globalStopFlag = false;
        
        this.filePaths = {
            injector: path.join(__dirname, '../files/attach.exe'),
            cheatDll: path.join(__dirname, '../files/Amalgamx64ReleaseTextmode.dll'),
            vacBypassLoader: path.join(__dirname, '../files/VAC-Bypass-Loader.exe'),
            vacBypassDll: path.join(__dirname, '../files/VAC-Bypass.dll'),
            textmodePreloadDll: path.join(__dirname, '../files/textmode-preload.dll'),
            accountsFile: path.join(__dirname, '../files/accounts.txt')
        };
        
        this.checkRequiredFiles();
        this.loadAccounts();
    }

    setIO(io) {
        this.io = io;
    }

    checkRequiredFiles() {
        const missingFiles = [];
        
        Object.entries(this.filePaths).forEach(([key, filePath]) => {
            if (!fs.existsSync(filePath)) {
                missingFiles.push({ key, path: filePath });
                logger.warn(`Missing required file: ${filePath}`);
            }
        });
        
        if (missingFiles.length > 0) {
            logger.error(`Missing ${missingFiles.length} required files. Place them in the 'files' directory.`);
            if (this.io) {
                this.io.emit('logMessage', `WARNING: ${missingFiles.length} required files are missing. Check server logs.`);
                
                missingFiles.forEach(file => {
                    logger.error(`Missing ${file.key}: ${file.path}`);
                    this.io.emit('logMessage', `Missing: ${path.basename(file.path)}`);
                });
            }
        } else {
            logger.info('All required files found in the files directory');
        }
    }

    loadAccounts() {
        try {
            if (!fs.existsSync(this.filePaths.accountsFile)) {
                logger.warn(`Accounts file not found at: ${this.filePaths.accountsFile}`);
                if (this.io) {
                    this.io.emit('logMessage', `WARNING: No accounts file found. Bot startup will likely fail.`);
                }
                return;
            }
            
            const accountsData = fs.readFileSync(this.filePaths.accountsFile, 'utf8');
            const lines = accountsData.split('\n');
            
            this.accounts = lines.filter(line => {
                const trimmedLine = line.trim();
                return trimmedLine && !trimmedLine.startsWith('#');
            }).map(line => {
                const [username, password] = line.trim().split(':');
                return { username, password };
            });
            
            logger.info(`Loaded ${this.accounts.length} accounts from accounts.txt`);
            
            if (this.accounts.length === 0 && this.io) {
                this.io.emit('logMessage', `WARNING: No accounts found in accounts.txt. Add accounts in format username:password.`);
            }
        } catch (err) {
            logger.error(`Error loading accounts: ${err.message}`);
            if (this.io) {
                this.io.emit('logMessage', `ERROR: Failed to load accounts: ${err.message}`);
            }
        }
    }

    initialize() {
        this.clearAllStopFlags();
        this.processInterval = setInterval(() => this.processQueue(), 1000);
        logger.info('Bot manager initialized');
        state.botAccounts = {};
    }

    clearAllStopFlags() {
        this.globalStopFlag = false;
        this.botStopFlags.clear();
        logger.info('Cleared all stop flags');
    }

    processQueue() {
        if (this.botProcessQueue.length === 0) {
            return;
        }

        if (this.globalStopFlag) {
            logger.info('Queue processing temporarily paused due to global stop flag');
            return;
        }

        if (state.autoRestartEnabled && state.restartingBots.size > 0) {
            logger.debug(`Auto-restart in progress for ${state.restartingBots.size} bot(s), pausing queue processing`);
            return;
        }

        const currentlyStarting = Array.from(state.botsStarting);
    
        const maxConcurrentStarts = state.config.maxConcurrentStarts || 3;

        if (currentlyStarting.length >= maxConcurrentStarts) {
            logger.debug(`Already starting ${currentlyStarting.length} bots, waiting...`);
            return;
        }

        if (state.isQuotaExceeded()) {
            logger.warn(`Bot quota (${state.config.botQuota}) exceeded, cannot start more bots`);
            this.io.emit('logMessage', `Bot quota (${state.config.botQuota}) exceeded, cannot start more bots`);
            return;
        }

        let nextBot = null;
        let nextBotIndex = -1;
        
        for (let i = 0; i < this.botProcessQueue.length; i++) {
            const botNumber = this.botProcessQueue[i];
            if (!this.botStopFlags.get(botNumber)) {
                nextBot = botNumber;
                nextBotIndex = i;
                break;
            } else {
                logger.info(`Skipping bot ${botNumber} in queue due to active stop flag`);
            }
        }
        
        if (nextBot === null) {
            logger.info('No bots in queue eligible to start (all have stop flags)');
            return;
        }
        
        this.botProcessQueue.splice(nextBotIndex, 1);
        this.startBot(nextBot);
        
        this.io.emit('queueUpdate', {
            currentlyStarting: Array.from(state.botsStarting),
            inQueue: this.botProcessQueue
        });
    }

    queueBot(botNumber) {
        if (this.botProcessQueue.includes(botNumber) || state.botsStarting.has(botNumber)) {
            logger.info(`Bot ${botNumber} already queued or starting`);
            return false;
        }

        if (state.activeBots.has(botNumber)) {
            logger.info(`Bot ${botNumber} is already active`);
            return false;
        }

        this.botProcessQueue.push(botNumber);
        state.botStatuses[botNumber] = BotStatus.INITIALIZING;
        
        logger.info(`Queued bot ${botNumber} for startup`);
        this.io.emit('logMessage', `Queued bot ${botNumber} for startup`);
        
        this.io.emit('queueUpdate', {
            currentlyStarting: Array.from(state.botsStarting),
            inQueue: this.botProcessQueue
        });
        
        this.io.emit('statusUpdate', {
            botNumber,
            status: BotStatus.INITIALIZING,
            pipeStatus: state.pipeStatuses[botNumber] || 'Disconnected'
        });
        
        return true;
    }

    async startBot(botNumber) {
        logger.info(`Starting bot ${botNumber}`);
        this.io.emit('logMessage', `Starting bot ${botNumber}`);
        
        state.botsStarting.add(botNumber);
        state.botStatuses[botNumber] = BotStatus.INITIALIZING;
        
        const account = this.getAccountForBot(botNumber);
        if (!account) {
            logger.error(`No account available for bot ${botNumber}`);
            this.io.emit('logMessage', `ERROR: No account available for bot ${botNumber}. Check accounts.txt file.`);
            state.botsStarting.delete(botNumber);
            state.botStatuses[botNumber] = BotStatus.CRASHED;
            this.updateBotStatus(botNumber);
            return false;
        }
        
        try {
            state.botAccounts[botNumber] = account;
            
            logger.info(`Using account ${account.username} for bot ${botNumber}`);
            this.io.emit('logMessage', `Using account ${account.username} for bot ${botNumber}`);
            
            if (this.globalStopFlag || this.botStopFlags.get(botNumber)) {
                throw new Error('Bot startup aborted due to stop flag');
            }
            
            state.botStatuses[botNumber] = BotStatus.INSTANCE_SETUP;
            this.updateBotStatus(botNumber);
            
            const instanceCreated = instanceManager.createInstance(botNumber);
            if (!instanceCreated) {
                throw new Error('Failed to create instance');
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            if (this.globalStopFlag || this.botStopFlags.get(botNumber)) {
                throw new Error('Bot startup aborted due to stop flag');
            }
            
            state.botStatuses[botNumber] = BotStatus.STEAM_STARTING;
            this.updateBotStatus(botNumber);
            
            try {
                await instanceManager.launchSteam(botNumber, account);
            } catch (error) {
                throw new Error('Failed to launch Steam');
            }
            
            if (this.globalStopFlag || this.botStopFlags.get(botNumber)) {
                throw new Error('Bot startup aborted due to stop flag');
            }
            
            if (state.config.tf2StartDelay && state.config.tf2StartDelay > 0) {
                const tf2DelaySeconds = state.config.tf2StartDelay;
                const tf2DelayMs = tf2DelaySeconds * 1000;
                logger.info(`=== APPLYING TF2 START DELAY: ${tf2DelayMs}ms (${tf2DelaySeconds} seconds) ===`);
                this.io.emit('logMessage', `>>> Waiting ${tf2DelaySeconds} seconds before starting TF2... <<<`);
                
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        resolve();
                    }, tf2DelayMs);
                    
                    const checkInterval = setInterval(() => {
                        if (this.globalStopFlag || this.botStopFlags.get(botNumber)) {
                            clearTimeout(timeout);
                            clearInterval(checkInterval);
                            reject(new Error('Bot startup aborted during TF2 start delay'));
                        }
                    }, 500);
                    
                    timeout.onComplete = () => clearInterval(checkInterval);
                });
                
                logger.info(`=== TF2 START DELAY COMPLETE, LAUNCHING TF2 NOW ===`);
                this.io.emit('logMessage', `>>> TF2 start delay complete, launching TF2 now <<<`);
            } else {
                logger.info(`No TF2 start delay configured, launching TF2 immediately`);
                this.io.emit('logMessage', `No TF2 start delay configured, launching TF2 immediately`);
            }
            
            if (this.globalStopFlag || this.botStopFlags.get(botNumber)) {
                throw new Error('Bot startup aborted due to stop flag');
            }
            
            state.botStatuses[botNumber] = BotStatus.TF2_STARTING;
            this.updateBotStatus(botNumber);
            
            const tf2Process = instanceManager.launchTF2(botNumber);
            if (!tf2Process) {
                throw new Error('Failed to launch TF2');
            }
            
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(resolve, 3000);
                
                const checkInterval = setInterval(() => {
                    if (this.globalStopFlag || this.botStopFlags.get(botNumber)) {
                        clearTimeout(timeout);
                        clearInterval(checkInterval);
                        reject(new Error('Bot startup aborted during TF2 initialization'));
                    }
                }, 500);
                
                timeout.onComplete = () => clearInterval(checkInterval);
            });
            
            if (state.config.enableTextmodeDelay && state.config.textmodeDelay > 0) {
                const textmodeDelaySeconds = state.config.textmodeDelay;
                const textmodeDelayMs = textmodeDelaySeconds * 1000;
                
                logger.info(`Textmode delay enabled, waiting ${textmodeDelaySeconds} seconds before injecting textmode-preload.dll`);
                this.io.emit('logMessage', `Waiting ${textmodeDelaySeconds} seconds before injecting textmode-preload.dll`);
                
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(resolve, textmodeDelayMs);
                    
                    const checkInterval = setInterval(() => {
                        if (this.globalStopFlag || this.botStopFlags.get(botNumber)) {
                            clearTimeout(timeout);
                            clearInterval(checkInterval);
                            reject(new Error('Bot startup aborted during textmode delay'));
                        }
                    }, 500);
                    
                    timeout.onComplete = () => clearInterval(checkInterval);
                });
            } else {
                logger.info(`Textmode delay disabled, injecting textmode-preload.dll immediately`);
            }
            
            if (this.globalStopFlag || this.botStopFlags.get(botNumber)) {
                throw new Error('Bot startup aborted due to stop flag');
            }
            
            state.botStatuses[botNumber] = BotStatus.INJECTING;
            this.updateBotStatus(botNumber);
            
            await this.injectTextmodePreload(botNumber);
            
            logger.info(`Waiting for TF2 to initialize before injecting cheat...`);
            this.io.emit('logMessage', `Waiting for TF2 to initialize before injecting cheat...`);
            
            if (this.globalStopFlag || this.botStopFlags.get(botNumber)) {
                throw new Error('Bot startup aborted due to stop flag');
            }
            
            const injectDelaySeconds = state.config.injectDelay || 5;
            const injectDelayMs = injectDelaySeconds * 1000;
            
            logger.info(`Waiting ${injectDelaySeconds} seconds before injecting cheat`);
            this.io.emit('logMessage', `Waiting ${injectDelaySeconds} seconds before injecting cheat`);
            
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(resolve, injectDelayMs);
                
                const checkInterval = setInterval(() => {
                    if (this.globalStopFlag || this.botStopFlags.get(botNumber)) {
                        clearTimeout(timeout);
                        clearInterval(checkInterval);
                        reject(new Error('Bot startup aborted during inject delay'));
                    }
                }, 500);
                
                timeout.onComplete = () => clearInterval(checkInterval);
            });
            
            if (this.globalStopFlag || this.botStopFlags.get(botNumber)) {
                throw new Error('Bot startup aborted before cheat injection');
            }
            
            await this.injectCheat(botNumber);
            
            state.botsStarting.delete(botNumber);
            state.activeBots.add(botNumber);
            state.botStatuses[botNumber] = BotStatus.ACTIVE;
            
            this.updateBotStatus(botNumber);
            this.io.emit('logMessage', `Bot ${botNumber} started successfully`);
            
            this.botStopFlags.delete(botNumber);
            
            this.io.emit('quotaUpdate', {
                current: state.getTotalActiveBots(),
                total: state.config.botQuota
            });
            
            return true;
        } catch (err) {
            logger.error(`Error starting bot ${botNumber}: ${err.message}`);
            this.io.emit('logMessage', `Error starting bot ${botNumber}: ${err.message}`);
            
            state.botsStarting.delete(botNumber);
            
            if (err.message.includes('aborted due to stop flag')) {
                state.botStatuses[botNumber] = BotStatus.STOPPED;
                logger.info(`Bot ${botNumber} startup aborted due to stop request`);
                this.io.emit('logMessage', `Bot ${botNumber} startup aborted due to stop request`);
            } else if (err.message.includes('instance')) {
                state.botStatuses[botNumber] = BotStatus.INSTANCE_ERROR;
            } else if (err.message.includes('Steam')) {
                state.botStatuses[botNumber] = BotStatus.STEAM_ERROR;
            } else if (err.message.includes('TF2')) {
                state.botStatuses[botNumber] = BotStatus.TF2_ERROR;
            } else if (err.message.includes('inject')) {
                state.botStatuses[botNumber] = BotStatus.INJECTION_ERROR;
            } else {
                state.botStatuses[botNumber] = BotStatus.CRASHED;
            }
            
            this.botStopFlags.delete(botNumber);
            
            this.updateBotStatus(botNumber);
            
            return false;
        }
    }
    
    getAccountForBot(botNumber) {
        if (this.accounts.length === 0) {
            this.loadAccounts();
        }
        
        if (this.accounts.length === 0) {
            return null;
        }
        
        const accountIndex = (botNumber - 1) % this.accounts.length;
        return this.accounts[accountIndex];
    }
    
    async injectTextmodePreload(botNumber) {
        logger.info(`Injecting textmode preload for bot ${botNumber}`);
        
        try {
            if (!fs.existsSync(this.filePaths.textmodePreloadDll)) {
                logger.error(`Textmode preload DLL not found at: ${this.filePaths.textmodePreloadDll}`);
                throw new Error('Textmode preload DLL not found');
            }
            
            if (!fs.existsSync(this.filePaths.injector)) {
                logger.error(`Injector not found at: ${this.filePaths.injector}`);
                throw new Error('Injector not found');
            }
            
            // Wait (max 20s) for TF2 process to appear for this bot
            let tf2ProcessId = this.getTF2ProcessIdAdvanced(botNumber);
            if (!tf2ProcessId) {
                const waitStart = Date.now();
                const maxWaitMs = 20000;
                const pollIntervalMs = 500;
                while (!tf2ProcessId && (Date.now() - waitStart) < maxWaitMs) {
                    await new Promise(r => setTimeout(r, pollIntervalMs));
                    tf2ProcessId = this.getTF2ProcessIdAdvanced(botNumber);
                }
            }

            if (!tf2ProcessId) {
                logger.error(`No TF2 process found for bot ${botNumber} after waiting 20s`);
                throw new Error('TF2 process not found for bot');
            }
            
            logger.info(`Injecting textmode-preload.dll into PID ${tf2ProcessId} for bot ${botNumber}`);
            this.io.emit('logMessage', `Injecting textmode-preload.dll into PID ${tf2ProcessId} (bot ${botNumber})`);
            
            // Inject directly targeting specific process ID
            const textmodePreloadCommand = `"${this.filePaths.injector}" --process-id ${tf2ProcessId} --inject "${this.filePaths.textmodePreloadDll}"`;
            
            return new Promise((resolve, reject) => {
                exec(textmodePreloadCommand, (error, stdout, stderr) => {
                    const success = stdout.includes("Successfully injected module");

                    if (error && !success) {
                        logger.error(`Error injecting textmode preload: ${error.message}`);
                        logger.error(`Textmode preload stderr: ${stderr}`);
                        logger.warn('Continuing despite textmode preload error');
                        resolve(false);
                        return;
                    }

                    logger.info(`Textmode preload output: ${stdout}`);
                    if (success) {
                        logger.info(`Textmode preload successfully injected for bot ${botNumber}`);
                        resolve(true);
                    } else {
                        logger.warn(`Textmode preload might have failed for bot ${botNumber}`);
                        resolve(false);
                    }
                });
            });
            
        } catch (err) {
            logger.error(`Textmode preload error for bot ${botNumber}: ${err.message}`);
            return false;
        }
    }
    
    async injectCheat(botNumber) {
        state.botStatuses[botNumber] = BotStatus.INJECTING;
        this.updateBotStatus(botNumber);
        
        try {
            if (!fs.existsSync(this.filePaths.cheatDll)) {
                logger.error(`Cheat DLL not found at: ${this.filePaths.cheatDll}`);
                throw new Error('Cheat DLL not found');
            }
            
            if (!fs.existsSync(this.filePaths.injector)) {
                logger.error(`Injector not found at: ${this.filePaths.injector}`);
                throw new Error('Injector not found');
            }
            
            logger.info(`Injecting cheat into bot ${botNumber}`);
            
            // Get the specific TF2 process ID for this bot
            const tf2ProcessId = this.getTF2ProcessIdAdvanced(botNumber);
            if (!tf2ProcessId) {
                logger.error(`No TF2 process found for bot ${botNumber}`);
                throw new Error('TF2 process not found for bot');
            }

            logger.info(`Injecting cheat DLL into PID ${tf2ProcessId} for bot ${botNumber}`);
            this.io.emit('logMessage', `Injecting cheat DLL into PID ${tf2ProcessId} (bot ${botNumber})`);
            
            // Inject directly targeting specific process ID
            const cheatInjectCommand = `"${this.filePaths.injector}" --process-id ${tf2ProcessId} --inject "${this.filePaths.cheatDll}"`;
            
            return new Promise((resolve, reject) => {
                exec(cheatInjectCommand, (error, stdout, stderr) => {
                    const successMsg = "Successfully injected module";
                    const success = stdout.includes(successMsg);

                    if (error && !success) {
                        logger.error(`Error injecting cheat: ${error.message}`);
                        logger.error(`Cheat injection stderr: ${stderr}`);
                        
                        setTimeout(() => {
                            const checkCommand = `tasklist /FI "PID eq ${tf2ProcessId}" /FO CSV`;
                            exec(checkCommand, (err, taskOutput) => {
                                if (err) {
                                    logger.error(`Error checking if TF2 is running: ${err.message}`);
                                    state.botStatuses[botNumber] = BotStatus.INJECTION_ERROR;
                                    this.updateBotStatus(botNumber);
                                    reject(new Error('Cheat injection failed'));
                                    return;
                                }
                                
                                if (taskOutput.includes(tf2ProcessId.toString())) {
                                    logger.warn(`TF2 process ${tf2ProcessId} is still running after injection error`);
                                    state.botStatuses[botNumber] = BotStatus.INJECTION_ERROR;
                                    this.updateBotStatus(botNumber);
                                    reject(new Error('Cheat injection failed'));
                                } else {
                                    logger.info(`TF2 process ${tf2ProcessId} exited during injection - checking if it restarted`);
                                    this.io.emit('logMessage', `Bot ${botNumber}: TF2 exited during injection - checking if it restarted`);
                                    
                                    setTimeout(() => {
                                        // Check if a new TF2 process is running for this bot
                                        const newTF2ProcessId = instanceManager.getBotTF2ProcessId(botNumber);
                                        if (!newTF2ProcessId) {
                                            logger.error(`TF2 did not restart after injection for bot ${botNumber}`);
                                            state.botStatuses[botNumber] = BotStatus.INJECTION_ERROR;
                                            this.updateBotStatus(botNumber);
                                            reject(new Error('TF2 did not restart after injection'));
                                        } else {
                                            logger.info(`TF2 restarted with new PID ${newTF2ProcessId} for bot ${botNumber} - assuming success`);
                                            state.botStatuses[botNumber] = BotStatus.INJECTED;
                                            this.updateBotStatus(botNumber);
                                            resolve(true);
                                        }
                                    }, 10000);
                                }
                            });
                        }, 1000);
                        return;
                    }
                    
                    logger.info(`Cheat injection output: ${stdout}`);

                    if (success) {
                        logger.info(`Cheat successfully injected for bot ${botNumber}`);
                        state.botStatuses[botNumber] = BotStatus.INJECTED;
                        this.updateBotStatus(botNumber);
                        resolve(true);
                    } else {
                        logger.error(`Cheat injection ran for bot ${botNumber}`);
                        state.botStatuses[botNumber] = BotStatus.INJECTION_ERROR;
                        this.updateBotStatus(botNumber);
                        reject(new Error('Cheat injection did not report anything.'));
                    }
                });
            });
            
        } catch (err) {
            logger.error(`Injection error for bot ${botNumber}: ${err.message}`);
            state.botStatuses[botNumber] = BotStatus.INJECTION_ERROR;
            this.updateBotStatus(botNumber);
            throw err;
        }
    }
    
    updateBotStatus(botNumber) {
        const status = state.botStatuses[botNumber];
        const pipeStatus = state.pipeStatuses[botNumber] || 'Disconnected';
        
        const botStatuses = {
            [botNumber]: {
                status: status,
                pipeStatus: pipeStatus,
                lastHeartbeat: state.lastHeartbeats[botNumber] || null,
                active: state.activeBots.has(botNumber),
                starting: state.botsStarting.has(botNumber),
                isRestarting: state.restartingBots.has(botNumber)
            }
        };
        
        this.io.emit('statusUpdate', {
            autoRestartEnabled: state.autoRestartEnabled,
            botStatuses: botStatuses
        });
        
        logger.info(`Updated bot ${botNumber} status: ${status}`);
    }
    
    async stopBot(botNumber) {
        logger.info(`Stopping bot ${botNumber}`);
        this.io.emit('logMessage', `Stopping bot ${botNumber}`);
        
        this.botStopFlags.set(botNumber, true);
        
        const queueIndex = this.botProcessQueue.indexOf(botNumber);
        if (queueIndex !== -1) {
            this.botProcessQueue.splice(queueIndex, 1);
            
            state.botStatuses[botNumber] = BotStatus.STOPPED;
            this.updateBotStatus(botNumber);
            
            this.io.emit('queueUpdate', {
                currentlyStarting: Array.from(state.botsStarting),
                inQueue: this.botProcessQueue
            });
            
            logger.info(`Removed bot ${botNumber} from queue`);
            
            this.botStopFlags.delete(botNumber);
            
            return true;
        }
        
        if (state.botsStarting.has(botNumber)) {
            state.botsStarting.delete(botNumber);
            
            let terminationResult = await instanceManager.stopBot(botNumber);
            
            state.botStatuses[botNumber] = BotStatus.STOPPED;
            this.updateBotStatus(botNumber);
            
            this.io.emit('quotaUpdate', {
                current: state.getTotalActiveBots(),
                total: state.config.botQuota
            });
            
            logger.info(`Stopped bot ${botNumber} during startup`);
            
            this.botStopFlags.delete(botNumber);
            
            return terminationResult;
        }
        
        if (state.activeBots.has(botNumber)) {
            let terminationResult = await instanceManager.stopBot(botNumber);
            
            state.botStatuses[botNumber] = BotStatus.STOPPED;
            this.updateBotStatus(botNumber);
            
            this.io.emit('quotaUpdate', {
                current: state.getTotalActiveBots(),
                total: state.config.botQuota
            });
            
            logger.info(`Stopped active bot ${botNumber}`);
            
            this.botStopFlags.delete(botNumber);
            
            return terminationResult;
        }
        
        logger.warn(`Cannot stop bot ${botNumber} - not in queue, starting, or active`);
        
        this.botStopFlags.delete(botNumber);
        
        return false;
    }
    
    restartBot(botNumber) {
        logger.info(`Manual restart requested for bot ${botNumber}`);
        this.io.emit('logMessage', `Manual restart requested for bot ${botNumber}`);
        
        if (!state.activeBots.has(botNumber)) {
            logger.warn(`Cannot restart bot ${botNumber}, it's not active`);
            this.io.emit('logMessage', `Cannot restart bot ${botNumber}, it's not active`);
            return false;
        }
        
        if (state.restartingBots.has(botNumber)) {
            logger.warn(`Bot ${botNumber} is already being restarted`);
            this.io.emit('logMessage', `Bot ${botNumber} is already being restarted`);
            return false;
        }
        
        this.stopBot(botNumber);
        
        setTimeout(() => {
            this.queueBot(botNumber);
        }, 5000);
        
        return true;
    }
    
    sendCommand(botNumber, command) {
        if (!state.pipeConnections.has(botNumber)) {
            logger.error(`Cannot send command to bot ${botNumber} - not connected`);
            return false;
        }
        
        const stream = state.pipeConnections.get(botNumber);
        if (!stream || !stream.writable) {
            logger.error(`Cannot send command to bot ${botNumber} - invalid connection`);
            return false;
        }
        
        try {
            const message = `${botNumber}:Command:${command}\n`;
            
            if (this.pipeServer) {
                const result = this.pipeServer.queueMessage(botNumber, message);
                logger.info(`Sent command to bot ${botNumber}: ${command}`);
                this.io.emit('logMessage', `Sent command to bot ${botNumber}: ${command}`);
                return result;
            } else {
                const result = stream.write(message);
                logger.info(`Sent command to bot ${botNumber}: ${command}`);
                this.io.emit('logMessage', `Sent command to bot ${botNumber}: ${command}`);
                return result;
            }
        } catch (err) {
            logger.error(`Error sending command to bot ${botNumber}: ${err.message}`);
            return false;
        }
    }
    
    sendCommandToAllBots(command) {
        logger.info(`Sending command to all bots: ${command}`);
        this.io.emit('logMessage', `Sending command to all bots: ${command}`);
        
        const results = [];
        let successCount = 0;
        
        for (const [botNumber, stream] of state.pipeConnections.entries()) {
            if (stream && stream.writable) {
                try {
                    const message = `${botNumber}:Command:${command}\n`;
                    
                    let success = false;
                    if (this.pipeServer) {
                        success = this.pipeServer.queueMessage(botNumber, message);
                    } else {
                        success = stream.write(message);
                    }
                    
                    if (success) {
                        successCount++;
                        results.push({ botNumber, success: true });
                        logger.info(`Command sent to bot ${botNumber}: ${command}`);
                    } else {
                        results.push({ botNumber, success: false, error: 'Message queued, waiting for buffer space' });
                        logger.warn(`Command queued for bot ${botNumber}: ${command}`);
                    }
                } catch (err) {
                    results.push({ botNumber, success: false, error: err.message });
                    logger.error(`Error sending command to bot ${botNumber}: ${err.message}`);
                }
            }
        }
        
        this.io.emit('logMessage', `Command sent to ${successCount} bots: ${command}`);
        return { successCount, results };
    }
    
    setPipeServer(pipeServer) {
        this.pipeServer = pipeServer;
    }
    
    async cleanup() {
        logger.info('Cleaning up all bots and instances');
        
        this.globalStopFlag = true;
        
        if (this.processInterval) {
            clearInterval(this.processInterval);
            this.processInterval = null;
        }
        
        await this.stopAllBots();
        
        logger.info('Bot cleanup complete');
    }
    
    async stopAllBots() {
        const allBots = new Set([
            ...state.activeBots,
            ...state.botsStarting,
            ...this.botProcessQueue
        ]);
        
        this.botProcessQueue = [];
        
        this.globalStopFlag = true;
        
        if (this.io) {
            this.io.emit('logMessage', `Stopping all ${allBots.size} active bots...`);
        }
        
        for (const botNumber of allBots) {
            this.botStopFlags.set(botNumber, true);
        }
        
        const stopPromises = [];
        for (const botNumber of allBots) {
            stopPromises.push(this.stopBot(botNumber));
        }
        
        if (stopPromises.length > 0) {
            logger.info(`Waiting for ${stopPromises.length} bots to stop...`);
            try {
                const results = await Promise.all(stopPromises);
                const successCount = results.filter(result => result === true).length;
                logger.info(`All bots stopped: ${successCount} successful, ${results.length - successCount} partial`);
                
                if (this.io) {
                    this.io.emit('logMessage', `All bots stopped`);
                }
            } catch (err) {
                logger.error(`Error stopping all bots: ${err.message}`);
                
                if (this.io) {
                    this.io.emit('logMessage', `Error during stop-all operation: ${err.message}`);
                }
            }
        } else {
            logger.info('No active bots to stop');
            
            if (this.io) {
                this.io.emit('logMessage', `No active bots to stop`);
            }
        }
        
        this.globalStopFlag = false;
        
        return true;
    }

    debugSteam(botNumber) {
        return instanceManager.launchSteamDebug(botNumber);
    }

    // Try to detect TF2 process for a given bot by scanning running tf_win64.exe command lines
    getTF2ProcessIdAdvanced(botNumber) {
        // 1) Ask instanceManager first
        let pid = instanceManager.getBotTF2ProcessId(botNumber);
        if (pid) return pid;

        // 2) Fallback: WMIC scan by -steamipcname argument
        try {
            const ipcName = `steam_bot_${botNumber}`;
            const output = execSync(`wmic process where (Name='tf_win64.exe') get ProcessId,CommandLine /format:csv`, { encoding: 'utf8' });
            const lines = output.split(/\r?\n/).filter(Boolean);
            for (const line of lines) {
                if (!line.includes(',')) continue;
                const parts = line.split(','); // Node,ProcessId,CommandLine
                const cmdline = parts.slice(2).join(',');
                if (cmdline.includes(ipcName)) {
                    const pidStr = parts[parts.length - 2] || parts[1]; // depending on wmic version
                    const found = parseInt(pidStr, 10);
                    if (!isNaN(found)) return found;
                }
            }
        } catch (err) {
            logger.debug(`WMIC scan failed for bot ${botNumber}: ${err.message}`);
        }

        /* Fallback: PowerShell Get-CimInstance (Windows 10/11 without wmic) */
        try {
            const ipcName = `steam_bot_${botNumber}`;
            const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'tf_win64.exe' } | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
            const psOut = execSync(psCmd, { encoding: 'utf8' });
            if (psOut && psOut.trim()) {
                const entries = JSON.parse(psOut);
                const list = Array.isArray(entries) ? entries : [entries];
                for (const proc of list) {
                    if (proc.CommandLine && proc.CommandLine.includes(ipcName)) {
                        const found = parseInt(proc.ProcessId, 10);
                        if (!isNaN(found)) return found;
                    }
                }
            }
        } catch (err) {
            logger.debug(`PowerShell scan failed for bot ${botNumber}: ${err.message}`);
        }

        return null;
    }
}

module.exports = new BotManager();