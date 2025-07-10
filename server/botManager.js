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

        // Anti-IPC conflict delay (ms) between successive bot launches
        this.ipcConflictDelay = state.config.ipcConflictDelay || 5000; // default 1s like catbot
        this.lastBotLaunchTime = 0;
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
        this.startPeriodicCleanup();
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

        // Ensure minimal delay between launches to avoid Steam IPC name clashes
        const now = Date.now();
        if (now - this.lastBotLaunchTime < this.ipcConflictDelay) {
            return; // wait for delay to elapse
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
        this.lastBotLaunchTime = Date.now();
        
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

            // Attempt textmode preload injection and abort if it fails
            const textmodeInjected = await this.injectTextmodePreload(botNumber);
            if (!textmodeInjected) {
                logger.error(`Textmode injection failed for bot ${botNumber} – terminating bot`);
                // Kill the bot cleanly to avoid rogue processes lingering
                await instanceManager.stopBot(botNumber);
                throw new Error('Textmode inject failed');
            }
            
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

            // Wait for pipe connection from cheat
            this.io.emit('logMessage', `Waiting for pipe connection (max 20s)...`);
            const connected = await this.waitForPipeConnection(botNumber, 20000);
            if (!connected) {
                throw new Error('Pipe connection timeout');
            }
            
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

            // If TF2 failed to launch or any injection step failed, immediately stop the bot
            if (err.message && (err.message.includes('TF2') || err.message.includes('inject'))) {
                try {
                    await instanceManager.stopBot(botNumber);
                } catch (_) {}
            }
            
            // Ensure processes are stopped on pipe timeout
            if (err.message.includes('Pipe connection timeout')) {
                try {
                    await instanceManager.stopBot(botNumber);
                } catch (_) {}

                // Restart bot after small delay to retry
                setTimeout(() => {
                    this.queueBot(botNumber);
                }, 3000);
            }
            
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
        // Lazy-load accounts if list empty
        if (this.accounts.length === 0) {
            this.loadAccounts();
        }

        if (this.accounts.length === 0) {
            logger.error(`No accounts loaded from accounts.txt`);
            return null;
        }

        // Line-based assignment: bot N uses account on line N (1-indexed)
        const accountIndex = botNumber - 1; // Convert to 0-indexed array
        
        if (accountIndex < 0) {
            logger.error(`Invalid bot number: ${botNumber} (must be >= 1)`);
            return null;
        }
        
        if (accountIndex >= this.accounts.length) {
            logger.error(`Bot ${botNumber} requires account on line ${botNumber}, but only ${this.accounts.length} accounts available in accounts.txt`);
            return null;
        }

        const account = this.accounts[accountIndex];
        
        if (!account || !account.username || !account.password) {
            logger.error(`Invalid account on line ${botNumber} of accounts.txt`);
        return null;
        }

        logger.info(`Assigning account from line ${botNumber} (${account.username}) to bot ${botNumber}`);
        return account;
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

            // Release account mapping
            delete state.botAccounts[botNumber];
            
            return true;
        }
        
        if (state.botsStarting.has(botNumber)) {
            state.botsStarting.delete(botNumber);
            
            let terminationResult = await instanceManager.stopBot(botNumber);
            await this.forceCleanupBotResources(botNumber);
            
            state.botStatuses[botNumber] = BotStatus.STOPPED;
            this.updateBotStatus(botNumber);
            
            this.io.emit('quotaUpdate', {
                current: state.getTotalActiveBots(),
                total: state.config.botQuota
            });
            
            logger.info(`Stopped bot ${botNumber} during startup`);
            
            this.botStopFlags.delete(botNumber);

            // Release account mapping
            delete state.botAccounts[botNumber];
            
            return terminationResult;
        }
        
        if (state.activeBots.has(botNumber)) {
            let terminationResult = await instanceManager.stopBot(botNumber);
            await this.forceCleanupBotResources(botNumber);
            
            state.botStatuses[botNumber] = BotStatus.STOPPED;
            this.updateBotStatus(botNumber);
            
            this.io.emit('quotaUpdate', {
                current: state.getTotalActiveBots(),
                total: state.config.botQuota
            });
            
            logger.info(`Stopped active bot ${botNumber}`);
            
            this.botStopFlags.delete(botNumber);

            // Release account mapping
            delete state.botAccounts[botNumber];
            
            return terminationResult;
        }
        
        logger.warn(`Cannot stop bot ${botNumber} - not in queue, starting, or active`);
        
        this.botStopFlags.delete(botNumber);
        
        return false;
    }

    // Force cleanup of all resources for a specific bot
    async forceCleanupBotResources(botNumber) {
        logger.info(`Force cleaning up resources for bot ${botNumber}`);
        
        try {
            // 1. Kill any Steam processes with this bot's IPC name
            const steamIpcName = `steam_bot_${botNumber}`;
            await this.killProcessesByCommandLine(`-master_ipc_name_override.*${steamIpcName}`);
            
            // 2. Kill any TF2 processes with this bot's IPC name  
            await this.killProcessesByCommandLine(`-steamipcname.*${steamIpcName}`);
            
            // 3. Clear Source engine lock files
            instanceManager.clearSourceLockFiles(botNumber);
            
            // 4. Clean up any orphaned processes for this bot
            await this.killOrphanedBotProcesses(botNumber);
            
            // 5. Wait a moment for cleanup to complete
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            logger.info(`Resource cleanup completed for bot ${botNumber}`);
        } catch (err) {
            logger.error(`Error during force cleanup for bot ${botNumber}: ${err.message}`);
        }
    }

    // Kill processes by command line pattern
    async killProcessesByCommandLine(pattern) {
        return new Promise((resolve) => {
            try {
                // Use PowerShell to find and kill processes by command line
                const psCommand = `powershell -NoProfile -Command "Get-CimInstance -ClassName Win32_Process | Where-Object { $_.CommandLine -match '${pattern}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`;
                
                exec(psCommand, (error, stdout, stderr) => {
                    if (error) {
                        logger.debug(`Process cleanup command failed: ${error.message}`);
                    } else {
                        logger.debug(`Executed process cleanup for pattern: ${pattern}`);
                    }
                    resolve();
                });
            } catch (err) {
                logger.error(`Error killing processes by command line: ${err.message}`);
                resolve();
            }
        });
    }

    // Kill any orphaned processes that might belong to this bot
    async killOrphanedBotProcesses(botNumber) {
        return new Promise((resolve) => {
            try {
                // Kill processes that might be associated with this bot ID
                const commands = [
                    `taskkill /F /FI "WINDOWTITLE eq Steam - Bot ${botNumber}*" /T`,
                    `taskkill /F /FI "WINDOWTITLE eq Team Fortress 2 - Bot ${botNumber}*" /T`,
                    `wmic process where "CommandLine like '%BOTID=${botNumber}%'" delete`
                ];
                
                let completed = 0;
                const total = commands.length;
                
                commands.forEach(cmd => {
                    exec(cmd, (error) => {
                        if (error) {
                            logger.debug(`Orphan cleanup command failed: ${error.message}`);
                        }
                        completed++;
                        if (completed === total) {
                            resolve();
                        }
                    });
                });
                
                // Timeout after 5 seconds
                setTimeout(() => {
                    if (completed < total) {
                        logger.debug(`Orphan cleanup timeout for bot ${botNumber}`);
                        resolve();
                    }
                }, 5000);
            } catch (err) {
                logger.error(`Error killing orphaned processes: ${err.message}`);
                resolve();
            }
        });
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
        
        this.stopPeriodicCleanup();
        
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
        
        // Perform global cleanup after stopping all bots
        await this.performGlobalCleanup();
        
        this.globalStopFlag = false;
        
        return true;
    }

    // Perform comprehensive global cleanup of all bot resources
    async performGlobalCleanup() {
        logger.info('Performing global cleanup of bot resources...');
        
        try {
            // 1. Kill all remaining Steam and TF2 processes that might be from bots
            await this.killProcessesByCommandLine('-master_ipc_name_override.*steam_bot_');
            await this.killProcessesByCommandLine('-steamipcname.*steam_bot_');
            
            // 2. Clear all Source engine lock files
            instanceManager.clearSourceLockFiles();
            
            // 3. Clear all bot states (accounts will be reassigned by line number on restart)
            state.activeBots.clear();
            state.botsStarting.clear();
            state.restartingBots.clear();
            state.botAccounts = {}; // Clear but accounts will be reassigned by line-based logic
            
            // 4. Wait for cleanup to complete
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            logger.info('Global cleanup completed - accounts will be reassigned by line number when bots restart');
            
            if (this.io) {
                this.io.emit('logMessage', 'Global resource cleanup completed');
            }
        } catch (err) {
            logger.error(`Error during global cleanup: ${err.message}`);
        }
    }

    // Add periodic cleanup task to prevent resource buildup
    startPeriodicCleanup() {
        // Run cleanup every 5 minutes
        this.cleanupInterval = setInterval(async () => {
            await this.performMaintenanceCleanup();
        }, 5 * 60 * 1000);
        
        logger.info('Started periodic maintenance cleanup');
    }

    stopPeriodicCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            logger.info('Stopped periodic maintenance cleanup');
        }
    }

    // Perform maintenance cleanup without stopping bots
    async performMaintenanceCleanup() {
        logger.debug('Performing maintenance cleanup...');
        
        try {
            // Clear orphaned Source engine lock files
            instanceManager.clearSourceLockFiles();
            
            // Clean up any stale bot states that don't have active processes
            let cleanedStates = 0;
            Object.keys(state.botStatuses).forEach(botNum => {
                const botNumber = parseInt(botNum);
                if (!state.activeBots.has(botNumber) && 
                    !state.botsStarting.has(botNumber) && 
                    !this.botProcessQueue.includes(botNumber)) {
                    
                    // Only clean up if bot has been in stopped state for a while
                    if (state.botStatuses[botNumber] === BotStatus.STOPPED) {
                        delete state.botStatuses[botNumber];
                        delete state.pipeStatuses[botNumber];
                        delete state.lastHeartbeats[botNumber];
                        delete state.botAccounts[botNumber];
                        cleanedStates++;
                    }
                }
            });
            
            if (cleanedStates > 0) {
                logger.info(`Cleaned up ${cleanedStates} stale bot states during maintenance`);
            }
            
            logger.debug('Maintenance cleanup completed');
        } catch (err) {
            logger.error(`Error during maintenance cleanup: ${err.message}`);
        }
    }

    debugSteam(botNumber) {
        return instanceManager.launchSteamDebug(botNumber);
    }

    // Try to detect TF2 process for a given bot by scanning running tf_win64.exe command lines
    getTF2ProcessIdAdvanced(botNumber) {
        /*
         * We try multiple strategies to locate the TF2 process that belongs to a specific bot.
         * Priority order:
         *   1. InstanceManager cache (fastest, if we already tracked the PID)
         *   2. PowerShell CIM query filtered by the unique –steamipcname value
         *   3. Legacy WMIC CSV scan (fallback for older systems)
         */

        const ipcName = `steam_bot_${botNumber}`;

        // 1) Ask InstanceManager cache first
        let pid = instanceManager.getBotTF2ProcessId(botNumber);
        if (pid) return pid;

        // 2) PowerShell (preferred – WMIC is deprecated on new Windows builds)
        try {
            const psCmd = `powershell -NoProfile -Command "Get-CimInstance -ClassName Win32_Process -Filter \\"Name='tf_win64.exe'\\" | Where-Object { $_.CommandLine -match '${ipcName}' } | Sort-Object CreationDate -Descending | Select-Object -First 1 -ExpandProperty ProcessId"`;
            const psOut = execSync(psCmd, { encoding: 'utf8' }).trim();
            const psPid = parseInt(psOut, 10);
            if (!isNaN(psPid) && psPid > 0) {
                return psPid;
            }
        } catch (err) {
            logger.debug(`PowerShell scan failed for bot ${botNumber}: ${err.message}`);
        }

        // 3) WMIC CSV fallback for older Windows versions
        try {
            const wmicCmd = `wmic process where (Name='tf_win64.exe') get ProcessId,CommandLine /format:csv`;
            const output = execSync(wmicCmd, { encoding: 'utf8' });
            const rows = output.split(/\r?\n/).filter(r => r.trim().length > 0 && r.includes(','));

            // WMIC doesn't guarantee ordering, sort rows by PID DESC to prefer newest processes (most likely our bot)
            rows.sort((a, b) => {
                const pidA = parseInt(a.split(',')[1], 10);
                const pidB = parseInt(b.split(',')[1], 10);
                return pidB - pidA;
            });

            for (const row of rows) {
                const [, pidStr, ...cmdParts] = row.split(','); // Node name discarded, pid is 2nd column
                const cmdline = cmdParts.join(',');
                if (cmdline.includes(ipcName)) {
                    const found = parseInt(pidStr, 10);
                    if (!isNaN(found)) {
                        return found;
                    }
                }
            }
        } catch (err) {
            logger.debug(`WMIC scan failed for bot ${botNumber}: ${err.message}`);
        }

        return null;
    }

    // Wait until cheat establishes pipe connection or timeout
    waitForPipeConnection(botNumber, timeoutMs = 20000) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                if (state.pipeConnections.has(botNumber) && state.pipeStatuses[botNumber] === 'Connected') {
                    resolve(true);
                    return;
                }
                if (Date.now() - start >= timeoutMs) {
                    resolve(false);
                    return;
                }
                setTimeout(check, 500);
            };
            check();
        });
    }

    // Emergency cleanup function - use when bots are getting environment conflicts
    async emergencyCleanup() {
        logger.warn('EMERGENCY CLEANUP: Force cleaning all bot resources...');
        
        if (this.io) {
            this.io.emit('logMessage', 'EMERGENCY CLEANUP: Cleaning all bot resources...');
        }
        
        try {
            // 1. Stop all bot processes immediately
            this.globalStopFlag = true;
            
            // 2. Kill ALL Steam and TF2 processes that could be from bots
            logger.info('Killing all Steam and TF2 bot processes...');
            await this.killAllBotProcesses();
            
            // 3. Clear all lock files and temporary files
            logger.info('Clearing all lock files...');
            instanceManager.clearSourceLockFiles();
            this.clearTempFiles();
            
            // 4. Reset all state
            logger.info('Resetting all bot state...');
            this.resetAllBotState();
            
            // 5. Clean up account mappings
            logger.info('Cleaning up account mappings...');
            state.botAccounts = {};
            
            // 6. Wait for cleanup to complete
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            this.globalStopFlag = false;
            
            logger.warn('EMERGENCY CLEANUP COMPLETED - You can now start bots again');
            
            if (this.io) {
                this.io.emit('logMessage', 'EMERGENCY CLEANUP COMPLETED - Ready to start bots');
            }
            
            return true;
        } catch (err) {
            logger.error(`Error during emergency cleanup: ${err.message}`);
            
            if (this.io) {
                this.io.emit('logMessage', `Emergency cleanup error: ${err.message}`);
            }
            
            return false;
        }
    }

    // Kill all bot-related processes
    async killAllBotProcesses() {
        const commands = [
            // Kill all Steam processes with bot IPC names
            `powershell -NoProfile -Command "Get-Process | Where-Object {$_.ProcessName -eq 'steam' -and $_.MainWindowTitle -like '*bot*'} | Stop-Process -Force"`,
            
            // Kill all TF2 processes with bot IPC names  
            `powershell -NoProfile -Command "Get-Process | Where-Object {$_.ProcessName -eq 'tf_win64'} | Stop-Process -Force"`,
            
            // Kill processes by command line patterns
            `powershell -NoProfile -Command "Get-CimInstance -ClassName Win32_Process | Where-Object { $_.CommandLine -match 'steam_bot_' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
            
            // Kill all VAC bypass processes
            `taskkill /F /IM "VAC-Bypass-Loader.exe" /T`,
            `taskkill /F /IM "attach.exe" /T`,
            
            // Kill processes with BOTID environment variable
            `wmic process where "CommandLine like '%BOTID=%'" delete`
        ];
        
        const promises = commands.map(cmd => {
            return new Promise(resolve => {
                exec(cmd, (error) => {
                    if (error) {
                        logger.debug(`Emergency cleanup command failed: ${error.message}`);
                    }
                    resolve();
                });
            });
        });
        
        await Promise.all(promises);
        
        // Wait for processes to fully terminate
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Clear temporary files that might cause conflicts
    clearTempFiles() {
        try {
            const tempDir = require('os').tmpdir();
            const patterns = [
                'source_engine*.lock',
                'steam_*.tmp',
                'tf2_*.tmp'
            ];
            
            const fs = require('fs');
            patterns.forEach(pattern => {
                try {
                    const files = fs.readdirSync(tempDir);
                    files.forEach(file => {
                        if (file.match(pattern.replace('*', '.*'))) {
                            const filePath = path.join(tempDir, file);
                            try {
                                fs.unlinkSync(filePath);
                                logger.debug(`Deleted temp file: ${filePath}`);
                            } catch (_) {
                                // Ignore files that can't be deleted
                            }
                        }
                    });
                } catch (_) {
                    // Ignore directory read errors
                }
            });
        } catch (err) {
            logger.debug(`Error clearing temp files: ${err.message}`);
        }
    }

    // Reset all bot state to clean slate
    resetAllBotState() {
        // Clear all bot collections
        state.activeBots.clear();
        state.botsStarting.clear();
        state.restartingBots.clear();
        
        // Clear process queue
        this.botProcessQueue = [];
        
        // Clear stop flags
        this.botStopFlags.clear();
        
        // Reset bot statuses
        state.botStatuses = {};
        
        // Clear pipe connections and statuses
        state.pipeConnections.clear();
        state.pipeStatuses = {};
        state.lastHeartbeats = {};
        
        // Clear instance tracking
        state.instances.clear();
        
        // Clear account mappings (will be reassigned by line-based logic)
        state.botAccounts = {};
        
        logger.info('All bot state has been reset - accounts will be reassigned by line number');
    }
}

module.exports = new BotManager();