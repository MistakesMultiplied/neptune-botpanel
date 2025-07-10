const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const logger = require('./logger');
const { state, BotStatus } = require('../shared/state');

// Instance manager for handling multiple Steam/TF2 instances without virtualization
class InstanceManager {
    constructor() {
        // Base directory for Steam instances
        this.instancesDir = path.join(__dirname, '../steam_instances');
        
        // Files paths
        this.filePaths = {
            injector: path.join(__dirname, '../files/attach.exe'),
            cheatDll: path.join(__dirname, '../files/Amalgamx64ReleaseTextmode.dll'),
            vacBypassLoader: path.join(__dirname, '../files/VAC-Bypass-Loader.exe'),
            vacBypassDll: path.join(__dirname, '../files/VAC-Bypass.dll'),
            textmodePreloadDll: path.join(__dirname, '../files/textmode-preload.dll')
        };
        
        // Initialize process monitoring
        this.processes = new Map();
        this.monitorInterval = null;
        // Track localconfig update intervals per bot
        this.localConfigIntervals = new Map();
        this.startProcessMonitoring();
        
        // Track problematic states for auto-restart grace period
        this.problemStatusTimestamps = new Map();
        
        // Store IO reference for status updates
        this.io = null;
        
        // Ensure instances directory exists
        this.ensureInstancesDirectory();
    }

    // --- Utility: clear Source engine lock files in temp dir (Windows/Linux) ---
    clearSourceLockFiles(botNumber = null) {
        const candidateDirs = new Set();

        // Temp directory first – safe to clean always
        candidateDirs.add(os.tmpdir());

        if (botNumber !== null && state.instances.has(botNumber)) {
            const instSteam = path.join(state.instances.get(botNumber), 'steam');
            candidateDirs.add(instSteam);
            candidateDirs.add(path.join(instSteam, 'steamapps'));
        }

        let totalDeleted = 0;
        for (const dir of candidateDirs) {
            try {
                if (!fs.existsSync(dir)) continue;
                const files = fs.readdirSync(dir);
                files.forEach(f => {
                    if (f.startsWith('source_engine') && f.endsWith('.lock')) {
                        const fullPath = path.join(dir, f);
                        try {
                            fs.unlinkSync(fullPath);
                            totalDeleted++;
                        } catch (err) {
                            // Skip files that are locked by a running process
                        }
                    }
                });
            } catch (_) {}
        }

        if (totalDeleted > 0) {
            logger.info(`Deleted ${totalDeleted} Source engine lock file(s) for bot ${botNumber !== null ? botNumber : 'global'}`);
        }
    }
    
    // Set the Socket.IO instance for real-time updates
    setIO(io) {
        this.io = io;
    }
    
    // Ensure the steam instances directory exists
    ensureInstancesDirectory() {
        try {
            if (!fs.existsSync(this.instancesDir)) {
                fs.mkdirSync(this.instancesDir, { recursive: true });
                logger.info(`Created Steam instances directory: ${this.instancesDir}`);
            }
        } catch (err) {
            logger.error(`Failed to create instances directory: ${err.message}`);
        }
    }
    
    // Create directory structure for a bot instance
    createInstance(botNumber) {
        const instanceDir = path.join(this.instancesDir, `bot${botNumber}`);
        
        try {
            if (fs.existsSync(instanceDir)) {
                logger.info(`Using existing instance directory for bot ${botNumber}`);
                state.instances.set(botNumber, instanceDir);
                return true;
            }
            
            // Create instance directory structure
            fs.mkdirSync(instanceDir, { recursive: true });
            
            // Create subdirectories
            const subdirs = ['userdata', 'config', 'logs'];
            subdirs.forEach(dir => {
                const dirPath = path.join(instanceDir, dir);
                fs.mkdirSync(dirPath, { recursive: true });
            });
            
            // -----------------------------------------------
            // Copy lightweight Steam client into instance dir
            // -----------------------------------------------
            try {
                const mainSteamRoot = path.dirname(state.config.steamPath);
                const instanceSteamDir = path.join(instanceDir, 'steam');
                if (!fs.existsSync(instanceSteamDir)) {
                    fs.mkdirSync(instanceSteamDir, { recursive: true });
                    logger.info(`Copying Steam client to ${instanceSteamDir}`);
                    // Copy everything except heavy directories
                    const skipDirs = ['steamapps', 'logs'];
                    const copyRecursiveSync = (src, dest) => {
                        const stats = fs.statSync(src);
                        const basename = path.basename(src);
                        if (stats.isDirectory()) {
                            if (skipDirs.includes(basename.toLowerCase())) return; // skip heavy dirs
                            if (!fs.existsSync(dest)) fs.mkdirSync(dest);
                            fs.readdirSync(src).forEach(child => copyRecursiveSync(path.join(src, child), path.join(dest, child)));
                        } else {
                            fs.copyFileSync(src, dest);
                        }
                    };
                    copyRecursiveSync(mainSteamRoot, instanceSteamDir);
                    logger.info(`Steam client copied for bot ${botNumber}`);
                }

                // Create junction for common game files
                const mainCommon = path.join(mainSteamRoot, 'steamapps', 'common');
                const destCommon = path.join(instanceSteamDir, 'steamapps', 'common');
                if (!fs.existsSync(destCommon)) {
                    fs.mkdirSync(path.dirname(destCommon), { recursive: true });
                    fs.symlinkSync(mainCommon, destCommon, 'junction');
                    logger.info(`Linked steamapps/common for bot ${botNumber}`);
                }

                // Disable Steam Client Service to avoid global tracking
                const svcDll = path.join(instanceSteamDir, 'steamservice.dll');
                if (fs.existsSync(svcDll)) {
                    try {
                        fs.renameSync(svcDll, svcDll + '.disabled');
                        logger.info(`Renamed steamservice.dll for bot ${botNumber}`);
                    } catch (dllErr) {
                        logger.warn(`Failed to rename steamservice.dll: ${dllErr.message}`);
                    }
                }
            } catch (steamErr) {
                logger.warn(`Failed preparing Steam client for bot ${botNumber}: ${steamErr.message}`);
            }
            
            // Store reference to the instance
            state.instances.set(botNumber, instanceDir);
            
            logger.info(`Created instance directory for bot ${botNumber}: ${instanceDir}`);
            return true;
        } catch (err) {
            logger.error(`Error creating instance for bot ${botNumber}: ${err.message}`);
            return false;
        }
    }
    
    // Set process priority and CPU affinity
    setProcessPriority(processName, priorityValue = 64) {
        try {
            const command = `wmic process where (Name='${processName}') CALL setpriority ${priorityValue}`;
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    logger.error(`Failed to set priority for ${processName}: ${error.message}`);
                    return;
                }
                logger.info(`Set priority for ${processName} to ${priorityValue}`);
            });
        } catch (err) {
            logger.error(`Error setting priority for ${processName}: ${err.message}`);
        }
    }
    
    // Launch a program with specific environment and settings
    launchProgram(botNumber, program, args = [], options = {}) {
        const {
            isBackground = true,
            priority = 'normal',
            cpuAffinity = null,
            workingDirectory = null
        } = options;
        
        const programFileName = path.basename(program).toLowerCase();
        
        // Map specific executables to priorities
        const priorityMap = {
            'vac-bypass-loader.exe': 'idle',
            'steam.exe': 'idle',
            'steamwebhelper.exe': 'idle',
            'tf_win64.exe': 'high'
        };
        
        const affinityMap = {
            'vac-bypass-loader.exe': '1', // CPU0 only
            'steam.exe': '1',
            'steamwebhelper.exe': '1'
            // tf_win64.exe gets full CPU usage
        };
        
        const finalPriority = priority !== 'normal' ? priority : (priorityMap[programFileName] || 'normal');
        const finalAffinity = cpuAffinity || affinityMap[programFileName];
        
        try {
            logger.info(`Launching for bot ${botNumber}: ${program} ${args.join(' ')}`);
            
            if (this.io) {
                this.io.emit('logMessage', `Launching ${path.basename(program)} for bot ${botNumber}${isBackground ? ' (background)' : ''}`);
            }
            
            // Set environment variables
            let env = {
                ...process.env,
                BOTID: botNumber.toString()
            };

            if (options && options.extraEnv) {
                env = { ...env, ...options.extraEnv };
            }
            
            // Build spawn options
            const spawnOptions = {
                env,
                detached: isBackground,
                stdio: isBackground ? 'ignore' : 'inherit'
            };
            
            if (workingDirectory) {
                spawnOptions.cwd = workingDirectory;
            }
            
            // For TF2 processes, also set working directory to instance directory
            if (programFileName.includes('tf_win64')) {
                const instanceDir = state.instances.get(botNumber);
                if (instanceDir) {
                    spawnOptions.cwd = instanceDir;
                    logger.info(`Setting TF2 working directory to: ${instanceDir}`);
                }
            }
            
            // Spawn the process
            let child;
            if (isBackground) {
                // For background processes, use start command with priority and affinity
                // But we need to explicitly set environment variables for Windows start command
                let startCommand = 'cmd /c "';
                
                // Set BOTID environment variable explicitly
                startCommand += `set BOTID=${botNumber} && `;
                
                startCommand += 'start ""';
                
                // Add priority flag
                const priorityFlags = {
                    'idle': '/low',
                    'below': '/belownormal',
                    'normal': '/normal',
                    'above': '/abovenormal',
                    'high': '/high',
                    'realtime': '/realtime'
                };
                if (priorityFlags[finalPriority]) {
                    startCommand += ` ${priorityFlags[finalPriority]}`;
                }
                
                // Add CPU affinity
                if (finalAffinity) {
                    startCommand += ` /affinity ${finalAffinity}`;
                }
                
                startCommand += ` /min "${program}" ${args.join(' ')}"`;
                
                logger.info(`Background launch command for bot ${botNumber}: ${startCommand}`);
                child = exec(startCommand, spawnOptions);
            } else {
                child = spawn(program, args, spawnOptions);
            }
            
                    // Store process reference for monitoring
        if (child) {
            this.processes.set(botNumber, {
                process: child,
                program,
                args,
                timestamp: Date.now(),
                type: programFileName.includes('tf_win64') ? 'tf2' : 'other',
                isBackground,
                pid: child.pid
            });
                
                        // Handle process events
        child.on('error', (error) => {
            logger.error(`Process error for bot ${botNumber} (PID: ${child.pid}): ${error.message}`);
            this.handleProcessError(botNumber, program, error);
        });
        
        child.on('exit', (code, signal) => {
            logger.info(`Process exited for bot ${botNumber} (PID: ${child.pid}): code=${code}, signal=${signal}`);
            this.handleProcessExit(botNumber, program, code);
        });
        
        // Log process creation
        logger.info(`Created process for bot ${botNumber}: PID=${child.pid}, program=${path.basename(program)}`);
                
                // Update status if this is TF2
                if (program.includes('tf_win64')) {
                    state.botStatuses[botNumber] = BotStatus.RUNNING;
                    this.broadcastBotStatus(botNumber);
                }
            }
            
            return child;
        } catch (err) {
            logger.error(`Error launching program for bot ${botNumber}: ${err.message}`);
            
            // Update status to reflect error
            if (program.includes('tf_win64.exe')) {
                state.botStatuses[botNumber] = BotStatus.TF2_ERROR;
            } else if (program.includes('steam.exe')) {
                state.botStatuses[botNumber] = BotStatus.STEAM_ERROR;
            } else {
                state.botStatuses[botNumber] = BotStatus.CRASHED;
            }
            
            this.broadcastBotStatus(botNumber);
            return null;
        }
    }
    
    // Launch Steam for a bot instance (replaces VAC bypass)
    launchSteam(botNumber, account, extraArgs = []) {
        const steamExePath = path.join(state.instances.get(botNumber), 'steam', 'steam.exe');
        const mainSteamExe = state.config.steamPath;

        // Ensure steam.exe exists in instance dir; if not, copy it from main install
        try {
            if (!fs.existsSync(steamExePath)) {
                if (!fs.existsSync(mainSteamExe)) {
                    throw new Error(`Main steam.exe not found at ${mainSteamExe}. Update state.config.steamPath`);
                }
                // create target dir if missing
                fs.mkdirSync(path.dirname(steamExePath), { recursive: true });
                fs.copyFileSync(mainSteamExe, steamExePath);
                logger.info(`Copied steam.exe to instance for bot ${botNumber}`);
            }
        } catch (copyErr) {
            logger.error(`Failed to copy steam.exe for bot ${botNumber}: ${copyErr.message}`);
            return Promise.reject(copyErr);
        }

        // Update status
        state.botStatuses[botNumber] = BotStatus.STEAM_STARTING;
        this.broadcastBotStatus(botNumber);

        // Write global launch options before starting Steam (ensures options present even on first run)
        const preLaunchOptions = this.getTF2LaunchArgs(botNumber).join(' ');
        this.writeSteamConfigLaunchOptions(botNumber, preLaunchOptions);

        // Schedule update of localconfig.vdf once userdata/<id>/config appears
        this.scheduleLocalConfigUpdate(botNumber, preLaunchOptions);

        // Build login args if account provided
        const args = [];
        if (account && account.username && account.password) {
            args.push('-login', account.username, account.password);
        }
        args.push('-nobootstrapupdate', '-nofriendsui', '-vgui', '-noreactlogin', `-master_ipc_name_override`, `steam_bot_${botNumber}`);
        args.push('-cefNoGPU', '-cefDisableGPUCompositing');
        args.push('-installpath', path.join(state.instances.get(botNumber), 'steam'));
        args.push('-silent');                    // Run Steam in silent mode
        args.push('-no-browser');               // Disable Steam browser
        // Append any extra debug args
        if (extraArgs && extraArgs.length) {
            args.push(...extraArgs);
        }

        // Launch Steam
        logger.info(`Launching Steam for bot ${botNumber}`);
        return new Promise((resolve, reject) => {
            const process = this.launchProgram(botNumber, steamExePath, args, {
                priority: 'idle',
                cpuAffinity: '1',
                workingDirectory: path.dirname(steamExePath),
                isBackground: false
            });
            if (!process) {
                state.botStatuses[botNumber] = BotStatus.STEAM_ERROR;
                this.broadcastBotStatus(botNumber);
                reject(new Error('Failed to launch Steam'));
                return;
            }

            // Wait up to 20 s for Steam window to initialize
            const timeout = setTimeout(() => {
                state.botStatuses[botNumber] = BotStatus.STEAM_STARTING;
                this.broadcastBotStatus(botNumber);
                resolve(true);
            }, 20000);

            process.on('error', (err) => {
                clearTimeout(timeout);
                state.botStatuses[botNumber] = BotStatus.STEAM_ERROR;
                this.broadcastBotStatus(botNumber);
                reject(err);
            });
        });
    }
    
    // Create bot identification files
    createBotFile(botNumber) {
        const instanceDir = state.instances.get(botNumber);
        if (!instanceDir) {
            logger.warn(`No instance directory found for bot ${botNumber}`);
            return;
        }
        
        const botFileName = `bot${botNumber}.txt`;
        const tf2FolderPath = path.dirname(state.config.tf2Path);
        
        try {
            // Create file in TF2 folder
            const tf2BotFile = path.join(tf2FolderPath, botFileName);
            fs.writeFileSync(tf2BotFile, `${botNumber}`);
            logger.info(`Created ${botFileName} in TF2 folder with ID: ${botNumber}`);
            
            // Create file in bot's instance directory
            const instanceBotFile = path.join(instanceDir, botFileName);
            fs.writeFileSync(instanceBotFile, `${botNumber}`);
            logger.info(`Created ${botFileName} in instance directory with ID: ${botNumber}`);
            
            // Create bot ID file in multiple locations for reliable identification
            const locations = [
                path.join(tf2FolderPath, `botid_${botNumber}.txt`),
                path.join(instanceDir, `botid_${botNumber}.txt`),
                path.join(instanceDir, 'config', `botid.txt`)
            ];
            
            locations.forEach(location => {
                try {
                    // Ensure directory exists
                    const dir = path.dirname(location);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    fs.writeFileSync(location, `${botNumber}`);
                    logger.info(`Created bot ID file: ${location}`);
                } catch (err) {
                    logger.warn(`Failed to create bot ID file ${location}: ${err.message}`);
                }
            });
            
            // Create bot-specific TF2 config file
            const tf2ConfigDir = path.join(tf2FolderPath, 'tf', 'cfg');
            const botConfigFile = path.join(tf2ConfigDir, `bot${botNumber}.cfg`);
            
            try {
                if (!fs.existsSync(tf2ConfigDir)) {
                    fs.mkdirSync(tf2ConfigDir, { recursive: true });
                }
                
                const configContent = `// Bot ${botNumber} configuration
echo "Bot ${botNumber} config loaded"
// Set bot identification
alias bot_id "echo Bot ID: ${botNumber}"
// Custom bot settings
exec autoexec.cfg
`;
                
                fs.writeFileSync(botConfigFile, configContent);
                logger.info(`Created TF2 config file: ${botConfigFile}`);
            } catch (err) {
                logger.warn(`Failed to create TF2 config file: ${err.message}`);
            }
            
        } catch (error) {
            logger.error(`Error creating bot file for bot ${botNumber}: ${error.message}`);
        }
    }
    
    // Launch TF2 in the instance via Steam (steam://run/440) instead of running tf_win64.exe directly
    launchTF2(botNumber, isBackground = true) {
        // Ensure common junction exists
        this.ensureSteamappsSymlink(botNumber);

        // Remove leftover Source engine lock files (prevents "only one instance" errors)
        this.clearSourceLockFiles(botNumber);

        // Update bot status
        state.botStatuses[botNumber] = BotStatus.TF2_STARTING;
        this.broadcastBotStatus(botNumber);

        // Create bot identification files
        this.createBotFile(botNumber);

        // Resolve Steam executable inside the bot instance
        const instanceDir = state.instances.get(botNumber);
        if (!instanceDir) {
            logger.error(`No instance directory found for bot ${botNumber}`);
            state.botStatuses[botNumber] = BotStatus.TF2_ERROR;
            this.broadcastBotStatus(botNumber);
            return false;
        }

        const steamExePath = path.join(instanceDir, 'steam', 'steam.exe');
        if (!fs.existsSync(steamExePath)) {
            logger.error(`steam.exe not found for bot ${botNumber} at ${steamExePath}`);
            state.botStatuses[botNumber] = BotStatus.TF2_ERROR;
            this.broadcastBotStatus(botNumber);
            return false;
        }

        // Build Steam URI command for this specific Steam instance
        const tf2LaunchArgs = this.getTF2LaunchArgs(botNumber);

        // Ensure Steam has our desired launch options stored
        this.setTF2LaunchOptions(botNumber, tf2LaunchArgs.join(' '));

        const steamArgs = ['steam://run/440'];

        const process = this.launchProgram(botNumber, steamExePath, steamArgs, {
            priority: 'normal', // keep Steam low priority, game gets its own
            cpuAffinity: '1',
            isBackground,
            workingDirectory: path.dirname(steamExePath),
            extraEnv: {
                STEAMIPCNAME: `steam_bot_${botNumber}`
            }
        });

        if (process) {
            if (this.io) {
                this.io.emit('logMessage', `Uruchomiono TF2 poprzez steam://run dla bota ${botNumber}`);
            }

            // TF2 will spawn shortly – we cannot get its PID here, so keep STARTING for now.
            // After a grace period, assume it is running.
            setTimeout(() => {
                if (state.botStatuses[botNumber] === BotStatus.TF2_STARTING) {
                    state.botStatuses[botNumber] = BotStatus.RUNNING;
                    this.broadcastBotStatus(botNumber);
                }
            }, 30000); // 30s grace period

            return process;
        }

        // If launching failed
        state.botStatuses[botNumber] = BotStatus.TF2_ERROR;
        this.broadcastBotStatus(botNumber);

        if (this.io) {
            this.io.emit('logMessage', `Failed to launch TF2 via Steam for bot ${botNumber}`);
        }

        return false;
    }
    
    // Stop a bot by terminating its processes
    stopBot(botNumber) {
        return new Promise(async (resolve) => {
            logger.info(`Stopping bot ${botNumber}`);

            // Gather all processes that belong to this bot
            const processes = [];
            for (const [bn, procInfo] of this.processes.entries()) {
                if (bn === botNumber) {
                    processes.push(procInfo);
                }
            }

            // Remove process records immediately to prevent double-kills
            this.processes.delete(botNumber);

            let terminationResult = true;

            try {
                for (const procInfo of processes) {
                    const pid = procInfo.pid;
                    if (!pid) continue;

                    // First try graceful kill via child reference
                    try {
                        if (procInfo.process && !procInfo.process.killed) {
                            procInfo.process.kill('SIGTERM');
                        }
                    } catch (_) {}

                    // Force kill after short delay
                    await new Promise(r => setTimeout(r, 1000));

                    // Ensure the PID is gone (Windows taskkill tree)
                    exec(`taskkill /F /T /PID ${pid}`, (error) => {
                        if (error) {
                            logger.warn(`taskkill failed for PID ${pid}: ${error.message}`);
                        }
                    });
                }
            } catch (err) {
                logger.error(`Error stopping bot ${botNumber}: ${err.message}`);
                terminationResult = false;
            }

            // Update bot status
            state.botStatuses[botNumber] = BotStatus.STOPPED;
            state.activeBots.delete(botNumber);
            state.restartingBots.delete(botNumber);
            this.broadcastBotStatus(botNumber);

            // clear any config interval for this bot
            if (this.localConfigIntervals.has(botNumber)) {
                clearInterval(this.localConfigIntervals.get(botNumber));
                this.localConfigIntervals.delete(botNumber);
            }

            logger.info(`Stopped bot ${botNumber} – result: ${terminationResult ? 'success' : 'partial'}`);
            resolve(terminationResult);
        });
    }
    
    // Handle process errors
    handleProcessError(botNumber, program, error) {
        logger.error(`Process error for bot ${botNumber} (${path.basename(program)}): ${error.message}`);
        
        if (program.includes('tf_win64.exe')) {
            state.botStatuses[botNumber] = BotStatus.TF2_ERROR;
        } else if (program.includes('steam.exe')) {
            state.botStatuses[botNumber] = BotStatus.STEAM_ERROR;
        } else {
            state.botStatuses[botNumber] = BotStatus.CRASHED;
        }
        
        this.broadcastBotStatus(botNumber);
        
        // Handle auto-restart if enabled
        if (state.autoRestartEnabled && !state.restartingBots.has(botNumber)) {
            this.handleProcessFailure(botNumber, program);
        }
    }
    
    // Handle process exit
    handleProcessExit(botNumber, program, exitCode) {
        if (exitCode !== 0) {
            logger.warn(`Process exited with code ${exitCode} for bot ${botNumber} (${path.basename(program)})`);
            
            if (state.activeBots.has(botNumber)) {
                state.botStatuses[botNumber] = BotStatus.CRASHED;
                this.broadcastBotStatus(botNumber);
                
                // Handle auto-restart if enabled
                if (state.autoRestartEnabled && !state.restartingBots.has(botNumber)) {
                    this.handleProcessFailure(botNumber, program);
                }
            }
        }
    }
    
    // Start process monitoring for auto-restart
    startProcessMonitoring() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
        }
        
        this.monitorInterval = setInterval(() => {
            this.checkProcesses();
        }, 5000); // Check every 5 seconds
        
        logger.info('Process monitoring started for auto-restart');
    }
    
    // Stop process monitoring
    stopProcessMonitoring() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
            logger.info('Process monitoring stopped');
        }
    }
    
    // Check processes for failures/crashes
    checkProcesses() {
        if (!state.autoRestartEnabled) return;
        
        // Check if any bots are currently restarting
        if (state.restartingBots.size > 0 && this.io) {
            this.io.emit('logMessage', `Bot start queue paused - auto-restart in progress for ${state.restartingBots.size} bot(s)`);
        }
        
        for (const [botNumber, processInfo] of this.processes.entries()) {
            // Skip bots that are already in restart process
            if (state.restartingBots.has(botNumber)) {
                continue;
            }
            
            // Skip if bot is in startup/injection phase
            const currentStatus = state.botStatuses[botNumber];
            const isStartupPhase = [
                BotStatus.INITIALIZING,
                BotStatus.INSTANCE_SETUP,
                BotStatus.STEAM_STARTING,
                BotStatus.TF2_STARTING,
                BotStatus.INJECTING,
                BotStatus.INJECTION_ERROR
            ].includes(currentStatus);
            
            if (isStartupPhase) {
                logger.debug(`Skipping auto-restart check for bot ${botNumber} - in startup phase: ${currentStatus}`);
                continue;
            }
            
            // Check if process was recently started (60 second grace period)
            const isRecentlyStarted = processInfo.timestamp && 
                (Date.now() - processInfo.timestamp < 60000);
                
            if (isRecentlyStarted) {
                logger.debug(`Skipping auto-restart check for bot ${botNumber} - recently started`);
                this.problemStatusTimestamps.delete(botNumber);
                continue;
            }
            
            // Check for problematic states
            if (currentStatus === BotStatus.CRASHED) {
                if (!this.problemStatusTimestamps.has(botNumber)) {
                    this.problemStatusTimestamps.set(botNumber, Date.now());
                }
                if (Date.now() - this.problemStatusTimestamps.get(botNumber) >= 10000) {
                    logger.warn(`Bot ${botNumber} has been in CRASHED state for >10s - triggering auto-restart`);
                    this.problemStatusTimestamps.delete(botNumber);
                    this.handleProcessFailure(botNumber, processInfo.program);
                }
                continue;
            }
            
            // Check pipe status
            const pipeStatus = state.pipeStatuses[botNumber];
            if (pipeStatus && pipeStatus.includes('Disconnected') && currentStatus === BotStatus.CONNECTED) {
                if (!this.problemStatusTimestamps.has(botNumber)) {
                    this.problemStatusTimestamps.set(botNumber, Date.now());
                }
                if (Date.now() - this.problemStatusTimestamps.get(botNumber) >= 10000) {
                    logger.warn(`Bot ${botNumber} has been CONNECTED with disconnected pipe for >10s - triggering auto-restart`);
                    if (this.io) {
                        this.io.emit('logMessage', `Bot ${botNumber}: pipe disconnected for 10s – auto-restarting bot`);
                    }
                    this.problemStatusTimestamps.delete(botNumber);
                    this.handleProcessFailure(botNumber, processInfo.program);
                }
                continue;
            } else {
                this.problemStatusTimestamps.delete(botNumber);
            }
        }
    }
    
    // Handle failed process and restart if auto-restart is enabled
    handleProcessFailure(botNumber, program) {
        if (!state.autoRestartEnabled) return;
        
        // If bot is already in restart process, skip
        if (state.restartingBots.has(botNumber)) {
            return;
        }
        
                    // Check if bot is in startup/injection phase
            const currentStatus = state.botStatuses[botNumber];
            const isStartupPhase = [
                BotStatus.INITIALIZING,
                BotStatus.INSTANCE_SETUP,
                BotStatus.STEAM_STARTING,
                BotStatus.TF2_STARTING,
                BotStatus.INJECTING,
                BotStatus.INJECTION_ERROR
            ].includes(currentStatus);
        
        if (isStartupPhase) {
            logger.info(`Not triggering auto-restart for bot ${botNumber} - in startup phase: ${currentStatus}`);
            return;
        }
        
        logger.info(`Auto-restart triggered for bot ${botNumber}`);
        
        // Mark bot as restarting
        state.restartingBots.add(botNumber);
        
        // Update status to reflect crash and upcoming restart
        state.botStatuses[botNumber] = BotStatus.CRASHED;
        
        // Remove from processes to avoid double restarts
        this.processes.delete(botNumber);
        
        // Stop all processes for this bot
        this.stopBot(botNumber);
        
        // Send status update to clients
        this.broadcastBotStatus(botNumber);
        
        // Emit auto-restart state update
        this.broadcastAutoRestartState();
        
        // Log the restart
        if (this.io) {
            this.io.emit('logMessage', `Auto-restart triggered for bot ${botNumber}`);
        }
        
        // Schedule restart after a delay
        setTimeout(() => {
            logger.info(`Restarting bot ${botNumber} after crash`);
            
            // Get account info for this bot if needed
            const account = state.botAccounts && state.botAccounts[botNumber];
            
            // Restart the bot
            this.restartBot(botNumber, account);
        }, 10000); // Wait 10 seconds before restart
    }
    
    // Restart a bot after crash
    restartBot(botNumber, account) {
        try {
            logger.info(`Performing restart for bot ${botNumber}`);
            
            // Only continue if auto-restart is still enabled
            if (!state.autoRestartEnabled) {
                state.restartingBots.delete(botNumber);
                this.broadcastAutoRestartState();
                return;
            }
            
            // Update status
            state.botStatuses[botNumber] = BotStatus.INITIALIZING;
            this.broadcastBotStatus(botNumber);
            
            // Add to active bots if not already there
            state.activeBots.add(botNumber);
            
            // Create instance
            this.createInstance(botNumber);
            
            // If account exists, launch with VAC bypass, otherwise just TF2
            if (account && account.username && account.password) {
                this.launchSteam(botNumber, account)
                    .then(() => {
                        // Wait for Steam to initialize
                        setTimeout(() => {
                            // Update status for launching TF2
                            state.botStatuses[botNumber] = BotStatus.TF2_STARTING;
                            this.broadcastBotStatus(botNumber);
                            
                            this.launchTF2(botNumber);
                            
                            // Mark bot as no longer restarting
                            state.restartingBots.delete(botNumber);
                            this.broadcastAutoRestartState();
                            
                            // Notify that restart is complete
                            if (this.io) {
                                this.io.emit('logMessage', `Auto-restart complete for bot ${botNumber}`);
                            }
                        }, 5000);
                    })
                    .catch(err => {
                        logger.error(`Failed to restart bot ${botNumber}: ${err.message}`);
                        state.restartingBots.delete(botNumber);
                        state.botStatuses[botNumber] = BotStatus.STEAM_ERROR;
                        this.broadcastBotStatus(botNumber);
                        this.broadcastAutoRestartState();
                        
                        if (this.io) {
                            this.io.emit('logMessage', `Auto-restart failed for bot ${botNumber}: ${err.message}`);
                        }
                    });
            } else {
                // Update status for launching TF2
                state.botStatuses[botNumber] = BotStatus.TF2_STARTING;
                this.broadcastBotStatus(botNumber);
                
                // Just launch TF2 without VAC bypass
                this.launchTF2(botNumber);
                
                // Mark bot as no longer restarting
                state.restartingBots.delete(botNumber);
                this.broadcastAutoRestartState();
                
                if (this.io) {
                    this.io.emit('logMessage', `Auto-restart complete for bot ${botNumber}`);
                }
            }
        } catch (err) {
            logger.error(`Error during restart for bot ${botNumber}: ${err.message}`);
            
            // Make sure to remove from restarting set even if an error occurs
            state.restartingBots.delete(botNumber);
            this.broadcastAutoRestartState();
            
            if (this.io) {
                this.io.emit('logMessage', `Auto-restart failed for bot ${botNumber}: ${err.message}`);
            }
        }
    }
    
    // Broadcast bot status update to clients
    broadcastBotStatus(botNumber) {
        if (!this.io) return;
        
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
    }
    
    // Broadcast auto-restart state to clients
    broadcastAutoRestartState() {
        if (!this.io) return;
        
        this.io.emit('autoRestartState', {
            enabled: state.autoRestartEnabled,
            restartingBots: Array.from(state.restartingBots)
        });
    }
    
    // Get TF2 process ID for a specific bot
    getBotTF2ProcessId(botNumber) {
        const processInfo = this.processes.get(botNumber);
        if (processInfo && processInfo.type === 'tf2' && processInfo.process && !processInfo.process.killed) {
            return processInfo.pid;
        }
        return null;
    }
    
    // Get all TF2 process IDs for injection targeting
    getAllTF2ProcessIds() {
        const pids = [];
        for (const [botNumber, processInfo] of this.processes.entries()) {
            if (processInfo.type === 'tf2' && processInfo.process && !processInfo.process.killed) {
                pids.push({
                    botNumber,
                    pid: processInfo.pid
                });
            }
        }
        return pids;
    }
    
    // Debug function to list all tracked processes
    debugProcessList() {
        logger.info('=== Current Process Tracking ===');
        for (const [botNumber, processInfo] of this.processes.entries()) {
            const status = processInfo.process && !processInfo.process.killed ? 'Running' : 'Dead';
            logger.info(`Bot ${botNumber}: PID=${processInfo.pid}, Type=${processInfo.type}, Status=${status}, Program=${path.basename(processInfo.program)}`);
        }
        logger.info('================================');
    }
    
    // Toggle auto-restart functionality
    toggleAutoRestart(enabled) {
        state.autoRestartEnabled = enabled;
        logger.info(`Auto-restart ${enabled ? 'enabled' : 'disabled'}`);
        
        // Save the auto-restart setting to config
        state.config.autoRestartEnabled = enabled;
        state.saveConfig();
        
        // Start or stop monitoring based on setting
        if (enabled) {
            this.startProcessMonitoring();
        } else {
            // Clear any pending restarts
            for (const botNumber of state.restartingBots) {
                logger.info(`Cancelling restart for bot ${botNumber}`);
            }
            state.restartingBots.clear();
        }
        
        // Broadcast updated state to clients
        this.broadcastAutoRestartState();
    }
    
    // Cleanup method
    async cleanup() {
        logger.info('Cleaning up all bot instances');
        
        // Stop process monitoring
        this.stopProcessMonitoring();
        
        // Stop all bots
        const allBots = Array.from(this.processes.keys());
        const stopPromises = allBots.map(botNumber => this.stopBot(botNumber));
        
        if (stopPromises.length > 0) {
            try {
                await Promise.all(stopPromises);
                logger.info('All bots stopped during cleanup');
            } catch (err) {
                logger.error(`Error during cleanup: ${err.message}`);
            }
        }
        
        logger.info('Instance cleanup complete');
    }

    // Launch Steam in debug/update mode for a specific bot
    launchSteamDebug(botNumber) {
        if (!state.instances.has(botNumber)) {
            this.createInstance(botNumber);
        }
        const account = state.botAccounts && state.botAccounts[botNumber] ? state.botAccounts[botNumber] : null;
        const debugArgs = [
            '-forcesteamupdate',
            '-forcepackagedownload',
            '-overridepackageurl',
            'https://web.archive.org/web/20230702125953if_/media.steampowered.com/client',
            '-exitsteam'
        ];
        // Re-use launchSteam with extraArgs
        return this.launchSteam(botNumber, account, debugArgs);
    }

    // Ensure steamapps/common junction exists for given bot
    ensureSteamappsSymlink(botNumber) {
        try {
            const instanceDir = state.instances.get(botNumber);
            if (!instanceDir) return;
            const mainSteamRoot = path.dirname(state.config.steamPath);
            const mainSteamapps = path.join(mainSteamRoot, 'steamapps');
            const destSteamapps = path.join(instanceDir, 'steam', 'steamapps');

            if (fs.existsSync(destSteamapps)) {
                if (fs.lstatSync(destSteamapps).isSymbolicLink()) {
                    // junction already in place
                    return;
                }
                // real folder -> remove and recreate as junction
                fs.rmSync(destSteamapps, { recursive: true, force: true });
            }
            // ensure parent dir exists
            fs.mkdirSync(path.dirname(destSteamapps), { recursive: true });
            fs.symlinkSync(mainSteamapps, destSteamapps, 'junction');
            logger.info(`Recreated steamapps junction for bot ${botNumber}`);

            // Removed manual copying of steamclient DLLs – rely on Steam's own files.
            // Still ensure that steam_appid.txt exists so the game starts without issues.
            try {
                const tf2Dir = path.join(destSteamapps, 'common', 'Team Fortress 2');
                if (!fs.existsSync(tf2Dir)) return; // TF2 not installed/copied yet.

                const appIdFile = path.join(tf2Dir, 'steam_appid.txt');
                if (!fs.existsSync(appIdFile)) {
                    fs.writeFileSync(appIdFile, '440');
                    logger.info(`Created steam_appid.txt for bot ${botNumber}`);
                }
            } catch (extraErr) {
                logger.warn(`Failed to create steam_appid.txt: ${extraErr.message}`);
            }
        } catch (err) {
            logger.warn(`Failed to ensure steamapps junction for bot ${botNumber}: ${err.message}`);
        }
    }

    // Write custom TF2 launch options into Steam's localconfig.vdf for the bot
    setTF2LaunchOptions(botNumber, launchOptionsString) {
        try {
            const instanceDir = state.instances.get(botNumber);
            if (!instanceDir) return;

            const userdataRoot = path.join(instanceDir, 'steam', 'userdata');
            if (!fs.existsSync(userdataRoot)) return;

            const sanitized = launchOptionsString.replace(/"/g, '');
            const newContent = `"UserLocalConfigStore"\n{\n\t"Broadcast"\n\t{\n\t\t"Permissions"\t\t"0"\n\t}\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"apps"\n\t\t\t\t{\n\t\t\t\t\t"440"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LaunchOptions"\t\t"${sanitized}"\n\t\t\t\t\t\t"DisableOverlay"\t\t"1"\n\t\t\t\t\t\t"DisableCloudSync"\t\t"1"\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t\t"system"\n\t\t\t\t{\n\t\t\t\t\t"EnableGameOverlay"\t\t"0"\n\t\t\t\t\t"DisableCloudSync"\t\t"1"\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}`;

            // Ensure each userdata/<id>/config/localconfig.vdf exists and has correct content
            const idDirs = fs.readdirSync(userdataRoot).filter(d => {
                try {
                    return fs.lstatSync(path.join(userdataRoot, d)).isDirectory();
                } catch (_) {
                    return false;
                }
            });
            idDirs.forEach(id => {
                const cfgDir = path.join(userdataRoot, id, 'config');
                try {
                    fs.mkdirSync(cfgDir, { recursive: true });
                    const cfgPath = path.join(cfgDir, 'localconfig.vdf');
                    fs.writeFileSync(cfgPath, newContent);
                    logger.info(`Zapisano localconfig.vdf dla bota ${botNumber}: ${cfgPath}`);

                    // Also ensure <id>/440/localconfig.vdf exists (some tools expect it here)
                    try {
                        const app440Dir = path.join(userdataRoot, id, '440');
                        fs.mkdirSync(app440Dir, { recursive: true });
                        const appCfgPath = path.join(app440Dir, 'localconfig.vdf');
                        fs.writeFileSync(appCfgPath, newContent);
                        logger.debug(`Utworzono localconfig.vdf w katalogu 440: ${appCfgPath}`);
                    } catch (err) {
                        logger.debug(`Nie można zapisać 440/localconfig.vdf dla ${id}: ${err.message}`);
                    }
                } catch (e) {
                    logger.debug(`Failed write ${id}: ${e.message}`);
                }
            });

            // Recursively walk userdata and ensure EVERY directory contains an up-to-date localconfig.vdf
            const walkAndEnsure = (dir) => {
                try {
                    // Always attempt to write/overwrite localconfig.vdf in current dir
                    const target = path.join(dir, 'localconfig.vdf');
                    try {
                        fs.writeFileSync(target, newContent);
                    } catch (err) {
                        logger.debug(`Cannot write ${target}: ${err.message}`);
                    }

                    // Recurse into subfolders
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory()) {
                            walkAndEnsure(path.join(dir, entry.name));
                        }
                    }
                } catch (_) {}
            };

            walkAndEnsure(userdataRoot);

            // Also ensure Steam Cloud is disabled in sharedconfig.vdf files
            this.disableSharedConfigCloud(botNumber);

            logger.info(`Applied launch options & overlay/broadcast disable for bot ${botNumber}`);
        } catch (err) {
            logger.warn(`setTF2LaunchOptions error: ${err.message}`);
        }
    }

    // Periodically attempts to write localconfig until success or timeout
    scheduleLocalConfigUpdate(botNumber, launchOptionsString) {
        // Clear any existing scheduled task for this bot
        if (this.localConfigIntervals.has(botNumber)) {
            clearInterval(this.localConfigIntervals.get(botNumber));
        }

        const interval = setInterval(() => {
            // Stop once the bot has reached the injection phase – by this point TF2 and textmode are initialised
            const currentStatus = state.botStatuses[botNumber];
            if (currentStatus && [BotStatus.INJECTING, BotStatus.INJECTED, BotStatus.INJECTION_ERROR].includes(currentStatus)) {
                clearInterval(interval);
                this.localConfigIntervals.delete(botNumber);
                logger.debug(`Stopped localconfig updater for bot ${botNumber} (status = ${currentStatus})`);
                return;
            }

            try {
                // Continually (re)apply both launch-option files so that Steam never overwrites them
                this.setTF2LaunchOptions(botNumber, launchOptionsString);
                this.writeSteamConfigLaunchOptions(botNumber, launchOptionsString);

                // Verify at least one localconfig.vdf exists after write – once confirmed, continue looping but with no exit until injection
                const instanceDir = state.instances.get(botNumber);
                if (!instanceDir) return;
                const userdataRoot = path.join(instanceDir, 'steam', 'userdata');
                const matches = [];
                const check = (dir) => {
                    try {
                        const entries = fs.readdirSync(dir, { withFileTypes: true });
                        for (const e of entries) {
                            const fp = path.join(dir, e.name);
                            if (e.isDirectory()) check(fp);
                            else if (e.isFile() && e.name.toLowerCase() === 'localconfig.vdf') matches.push(fp);
                        }
                    } catch(_){}
                };
                check(userdataRoot);
                if (matches.length>0) {
                    logger.debug(`localconfig.vdf confirmed for bot ${botNumber} (count=${matches.length})`);
                }
            } catch (err) {
                logger.debug(`localconfig updater error for bot ${botNumber}: ${err.message}`);
            }
        }, 500);

        this.localConfigIntervals.set(botNumber, interval);
    }

    // Build array of default TF2 launch arguments for given bot
    getTF2LaunchArgs(botNumber) {
        return [
            '-steam',
            '-steamipcname', `steam_bot_${botNumber}`,
            '-textmode',
            '-nosound',
            '-nocrashdialog',
            '-novid',
            '-insecure',
            '-nosound',
            '-noshaderapi',
            '-nosteamoverlay'
        ];
    }

    // Write launch options into steam/config/config.vdf before Steam starts
    writeSteamConfigLaunchOptions(botNumber, launchOptionsString) {
        try {
            const instanceDir = state.instances.get(botNumber);
            if (!instanceDir) return;

            const cfgDir = path.join(instanceDir, 'steam', 'config');
            fs.mkdirSync(cfgDir, { recursive: true });
            const cfgPath = path.join(cfgDir, 'config.vdf');

            const sanitized = launchOptionsString.replace(/"/g, '');
            const content = `"InstallConfigStore"\n{\n    "Software"\n    {\n        "Valve"\n        {\n            "Steam"\n            {\n                "Broadcast"\n                {\n                    "Permissions"\t\t"0"\n                }\n                "apps"\n                {\n                    "440"\n                    {\n                        "LaunchOptions"\t\t"${sanitized}"\n                        "DisableOverlay"\t\t"1"\n                    }\n                }\n            }\n        }\n    }\n}`;

            fs.writeFileSync(cfgPath, content);
            logger.info(`Wrote pre-Steam LaunchOptions for bot ${botNumber}`);
        } catch (err) {
            logger.warn(`writeSteamConfigLaunchOptions failed for bot ${botNumber}: ${err.message}`);
        }
    }

    // Disable Steam Cloud for this bot by overwriting every sharedconfig.vdf under userdata/<id>/7/remote
    disableSharedConfigCloud(botNumber) {
        try {
            const instanceDir = state.instances.get(botNumber);
            if (!instanceDir) return;

            const userdataRoot = path.join(instanceDir, 'steam', 'userdata');
            if (!fs.existsSync(userdataRoot)) return;

            // VDF forcing Steam Cloud disabled globally and for TF2 (app 440)
            const cloudContent = `"UserRoamingConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"cloudenabled"\t\t"0"\n\t\t\t\t"apps"\n\t\t\t\t{\n\t\t\t\t\t"7"\n\t\t\t\t\t{\n\t\t\t\t\t\t"CloudEnabled"\t\t"0"\n\t\t\t\t\t}\n\t\t\t\t\t"440"\n\t\t\t\t\t{\n\t\t\t\t\t\t"cloudenabled"\t\t"0"\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}`;

            const idDirs = fs.readdirSync(userdataRoot).filter(d => {
                try {
                    return fs.lstatSync(path.join(userdataRoot, d)).isDirectory();
                } catch (_) {
                    return false;
                }
            });

            idDirs.forEach(id => {
                const remoteDir = path.join(userdataRoot, id, '7', 'remote');

                // Helper to recursively create/overwrite sharedconfig.vdf in every subdirectory
                const walkRemote = (dir) => {
                    try {
                        fs.mkdirSync(dir, { recursive: true });
                        const cfgPath = path.join(dir, 'sharedconfig.vdf');
                        try {
                            fs.writeFileSync(cfgPath, cloudContent);
                        } catch (err) {
                            logger.debug(`Cannot write ${cfgPath}: ${err.message}`);
                        }

                        const entries = fs.readdirSync(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            if (entry.isDirectory()) {
                                walkRemote(path.join(dir, entry.name));
                            }
                        }
                    } catch (_) {}
                };

                walkRemote(remoteDir);
                logger.info(`Wrote sharedconfig.vdf (CloudEnabled=0) recursively for bot ${botNumber} in ${remoteDir}`);
            });
        } catch (err) {
            logger.warn(`disableSharedConfigCloud error: ${err.message}`);
        }
    }
}

module.exports = new InstanceManager();