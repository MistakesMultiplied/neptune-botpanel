// Child process utilities
// Added execSync to allow synchronous PowerShell execution for mutex cleanup
const { exec, spawn, execSync } = require('child_process');
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
        
        // TF2 Process Scanner for rogue processes
        this.tf2ScannerInterval = null;
        this.lastTF2ScanTime = 0;
        
        // Ensure instances directory exists
        this.ensureInstancesDirectory();
        
        // Start TF2 process scanner
        this.startTF2ProcessScanner();
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

    /**
     * Release lingering Source Engine named mutexes that can prevent multiple game instances.
     * Works only on Windows – silently no-ops on other platforms.
     * This uses a short, synchronous PowerShell script to open and immediately close
     * the well-known mutex names used by Source games. When no process holds a handle
     * to those mutexes, closing them effectively removes the kernel object, lifting
     * the single-instance restriction. If another process still owns the handle the
     * call is harmless.
     */
    releaseSourceEngineMutexes() {
        if (process.platform !== 'win32') {
            return; // Only relevant on Windows
        }

        try {
            const mutexNames = [
                'SourceEngineMutex',
                'hl2_singleton_mutex',
                'SteamMasterPipeMutex'
            ];

            // Build a small PowerShell script that attempts to open each mutex and
            // then disposes the handle. Any errors (e.g., mutex not found) are ignored.
            const psScript = mutexNames.map(name => `try { $m = [System.Threading.Mutex]::OpenExisting('${name}'); if ($m) { $m.Close(); } } catch { }`).join('; ');

            execSync(`powershell -NoProfile -Command "${psScript}"`, {
                stdio: 'ignore',
                windowsHide: true,
                timeout: 5000
            });

            logger.debug('Attempted to release Source Engine mutexes');
        } catch (err) {
            // Non-fatal – just log at debug level to avoid spam
            logger.debug(`Mutex release error: ${err.message}`);
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
            // Always recreate the instance directory to ensure clean state
            if (fs.existsSync(instanceDir)) {
                logger.info(`Cleaning existing instance directory for bot ${botNumber}`);
                try {
                    // Only remove userdata and config to preserve Steam client files
                    const userDataDir = path.join(instanceDir, 'userdata');
                    const configDir = path.join(instanceDir, 'config');
                    const logsDir = path.join(instanceDir, 'logs');
                    
                    if (fs.existsSync(userDataDir)) {
                        fs.rmSync(userDataDir, { recursive: true, force: true });
                    }
                    if (fs.existsSync(configDir)) {
                        fs.rmSync(configDir, { recursive: true, force: true });
                    }
                    if (fs.existsSync(logsDir)) {
                        fs.rmSync(logsDir, { recursive: true, force: true });
            }
                } catch (cleanupErr) {
                    logger.warn(`Failed to clean existing directories for bot ${botNumber}: ${cleanupErr.message}`);
                }
            } else {
            // Create instance directory structure
            fs.mkdirSync(instanceDir, { recursive: true });
            }
            
            // Create subdirectories with bot-specific names
            const subdirs = ['userdata', 'config', 'logs', 'dumps', 'appcache'];
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
                    const skipDirs = ['steamapps', 'logs', 'userdata', 'config', 'dumps', 'appcache'];
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
                const mainSteamapps = path.join(mainSteamRoot, 'steamapps');
                const destSteamapps = path.join(instanceSteamDir, 'steamapps');
                if (!fs.existsSync(destSteamapps)) {
                    if (fs.existsSync(mainSteamapps)) {
                        fs.symlinkSync(mainSteamapps, destSteamapps, 'junction');
                        logger.info(`Linked steamapps directory for bot ${botNumber}`);
                    } else {
                        logger.warn(`Main steamapps directory not found, cannot create junction for bot ${botNumber}`);
                    }
                }

                // Create bot-specific userdata, config, logs directories in Steam instance
                const steamSubDirs = ['userdata', 'config', 'logs', 'dumps', 'appcache'];
                steamSubDirs.forEach(dir => {
                    const steamSubDir = path.join(instanceSteamDir, dir);
                    if (!fs.existsSync(steamSubDir)) {
                        fs.mkdirSync(steamSubDir, { recursive: true });
                    }
                });

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

                // Create bot-specific registry.vdf to prevent Steam account conflicts
                const registryFile = path.join(instanceSteamDir, 'registry.vdf');
                if (fs.existsSync(registryFile)) {
                    try {
                        fs.unlinkSync(registryFile);
                        logger.info(`Removed existing registry.vdf for bot ${botNumber}`);
                    } catch (regErr) {
                        logger.warn(`Failed to remove registry.vdf: ${regErr.message}`);
                    }
                }

                // Create bot-specific config.vdf
                const configFile = path.join(instanceSteamDir, 'config', 'config.vdf');
                try {
                    fs.mkdirSync(path.dirname(configFile), { recursive: true });
                    const configContent = `"InstallConfigStore"
{
    "Software"
    {
        "Valve"
        {
            "Steam"
            {
                "SourceModInstallPath"		""
                "ToolInstallPath"		""
                "AlreadyRetriedOfflineMode"		"0"
                "StartupMode"		"0"
                "SuppressFirstRunDialog"		"1"
                "RunningOffline"		"0"
                "BotInstance"		"${botNumber}"
            }
        }
    }
}`;
                    fs.writeFileSync(configFile, configContent);
                    logger.info(`Created bot-specific config.vdf for bot ${botNumber}`);
                } catch (configErr) {
                    logger.warn(`Failed to create config.vdf: ${configErr.message}`);
                }
            } catch (steamErr) {
                logger.warn(`Failed preparing Steam client for bot ${botNumber}: ${steamErr.message}`);
            }
            
            // Store reference to the instance
            state.instances.set(botNumber, instanceDir);

            // Pre-write launch option files so localconfig.vdf is already in place before Steam starts
            try {
                const launchOptionsString = this.getTF2LaunchArgs(botNumber).join(' ');
                // Write both userdata localconfig and steam config files right away
                this.setTF2LaunchOptions(botNumber, launchOptionsString);
                this.writeSteamConfigLaunchOptions(botNumber, launchOptionsString);
                logger.info(`Pre-wrote localconfig.vdf and config.vdf for bot ${botNumber}`);
            } catch (preWriteErr) {
                logger.warn(`Failed to pre-write launch options for bot ${botNumber}: ${preWriteErr.message}`);
            }

            logger.info(`Created isolated instance directory for bot ${botNumber}: ${instanceDir}`);
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
            
            // Set bot-specific environment variables
            let env = {
                ...process.env,
                BOTID: botNumber.toString(),
                BOT_INSTANCE_ID: `bot_${botNumber}`,
                STEAM_INSTANCE_PATH: state.instances.get(botNumber) || '',
                // Clear any conflicting Steam environment variables
                STEAM_COMPAT_CLIENT_INSTALL_PATH: undefined,
                STEAM_COMPAT_DATA_PATH: undefined
            };

            // Add bot-specific Steam environment for isolation
            if (programFileName.includes('steam')) {
                const instanceDir = state.instances.get(botNumber);
                if (instanceDir) {
                    const steamDir = path.join(instanceDir, 'steam');
                    env.STEAM_COMPAT_CLIENT_INSTALL_PATH = steamDir;
                    env.STEAM_COMPAT_DATA_PATH = path.join(instanceDir, 'userdata');
                    env.STEAMAPPDATA = path.join(instanceDir, 'userdata');
                    env.LOCALAPPDATA = path.join(instanceDir, 'config');
                    env.TEMP = path.join(instanceDir, 'logs'); // Use bot-specific temp
                    env.TMP = path.join(instanceDir, 'logs');
                }
            }

            // Add TF2-specific environment isolation
            if (programFileName.includes('tf_win64')) {
                const instanceDir = state.instances.get(botNumber);
                if (instanceDir) {
                    env.TF2_INSTANCE_PATH = instanceDir;
                    env.STEAMIPCNAME = `steam_bot_${botNumber}`;
                    env.TEMP = path.join(instanceDir, 'logs');
                    env.TMP = path.join(instanceDir, 'logs');
                }
            }

            if (options && options.extraEnv) {
                env = { ...env, ...options.extraEnv };
            }
            
            // Build spawn options with bot-specific working directory
            const botInstanceDir = state.instances.get(botNumber);
            const spawnOptions = {
                env,
                detached: isBackground,
                stdio: isBackground ? 'ignore' : 'inherit',
                cwd: workingDirectory || botInstanceDir || process.cwd()
            };
            
            // For Steam processes, ensure they use the bot's Steam directory
            if (programFileName.includes('steam')) {
                const instanceDir = state.instances.get(botNumber);
                if (instanceDir) {
                    spawnOptions.cwd = path.join(instanceDir, 'steam');
                    logger.info(`Setting Steam working directory to: ${spawnOptions.cwd}`);
                }
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
                // Set all environment variables explicitly
                let startCommand = 'cmd /c "';
                
                // Set environment variables explicitly for complete isolation
                Object.entries(env).forEach(([key, value]) => {
                    if (value !== undefined && value !== null) {
                        startCommand += `set ${key}=${value} && `;
                    }
                });
                
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
                logger.info(`Created isolated process for bot ${botNumber}: PID=${child.pid}, program=${path.basename(program)}, cwd=${spawnOptions.cwd}`);
                
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

        // Clear leftover Source Engine lock files and mutexes before starting Steam
        this.clearSourceLockFiles(botNumber);
        this.releaseSourceEngineMutexes();

        const preLaunchOptions = this.getTF2LaunchArgs(botNumber).join(' ');
        logger.info(`s ${botNumber} ===`);
        logger.info(`Launch options: ${preLaunchOptions}`);
        
        for (let i = 0; i < 3; i++) {
            this.writeSteamConfigLaunchOptions(botNumber, preLaunchOptions);
            this.setTF2LaunchOptions(botNumber, preLaunchOptions);
            logger.info(`Pre-Steam launch options write ${i + 1}/3 completed for bot ${botNumber}`);
        }

        // Schedule continuous monitoring and updating of localconfig.vdf
        this.scheduleLocalConfigUpdate(botNumber, preLaunchOptions);

        // Build login args if account provided
        const args = [];
        if (account && account.username && account.password) {
            args.push('-login', account.username, account.password);
        }
        
        // Add bot-specific isolation arguments
        const steamIpcName = `steam_bot_${botNumber}`;
        args.push('-nobootstrapupdate', '-nofriendsui', '-vgui', '-noreactlogin');
        args.push(`-master_ipc_name_override`, steamIpcName);
        args.push('-cefNoGPU', '-cefDisableGPUCompositing');
        args.push('-installpath', path.join(state.instances.get(botNumber), 'steam'));
        args.push('-silent');                    // Run Steam in silent mode
        args.push('-nobrowser');           // Prevent Steam from attempting app updates while bots are running
        args.push('-inhibitdownloads');          // Prevent Steam from attempting game updates while bots are running
        
        // Add environment isolation
        args.push('-no-shared-data');            // Prevent shared data conflicts
        args.push('-no-crash-handler');          // Disable crash reporting to prevent conflicts
        
        // Append any extra debug args
        if (extraArgs && extraArgs.length) {
            args.push(...extraArgs);
        }

        // Launch Steam
        logger.info(`Launching Steam for bot ${botNumber} with IPC name: ${steamIpcName}`);
        return new Promise((resolve, reject) => {
            const process = this.launchProgram(botNumber, steamExePath, args, {
                priority: 'idle',
                cpuAffinity: '1',
                workingDirectory: path.dirname(steamExePath),
                isBackground: false,
                extraEnv: {
                    // Add additional environment isolation
                    STEAMIPCNAME: steamIpcName,
                    STEAM_COMPAT_CLIENT_INSTALL_PATH: path.join(state.instances.get(botNumber), 'steam'),
                    STEAM_INSTANCE_ID: `bot_${botNumber}`
                }
            });
            if (!process) {
                state.botStatuses[botNumber] = BotStatus.STEAM_ERROR;
                this.broadcastBotStatus(botNumber);
                reject(new Error('Failed to launch Steam'));
                return;
            }

            // Continue writing launch options AFTER Steam starts for 10 seconds
            const afterLaunchInterval = setInterval(() => {
                this.setTF2LaunchOptions(botNumber, preLaunchOptions);
                this.writeSteamConfigLaunchOptions(botNumber, preLaunchOptions);
                logger.debug(`Post-Steam launch options refresh for bot ${botNumber}`);
            }, 1000);

            // Wait up to 20 s for Steam window to initialize
            const timeout = setTimeout(() => {
                clearInterval(afterLaunchInterval);
                state.botStatuses[botNumber] = BotStatus.STEAM_STARTING;
                this.broadcastBotStatus(botNumber);
                logger.info(`Steam initialization timeout reached for bot ${botNumber} - continuing`);
                resolve(true);
            }, 20000);

            process.on('error', (err) => {
                clearTimeout(timeout);
                clearInterval(afterLaunchInterval);
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
        // Prevent duplicate TF2 launches for this bot
        const existingPid = this.getBotTF2ProcessId(botNumber);
        if (existingPid) {
            logger.warn(`TF2 already running for bot ${botNumber} (PID ${existingPid}) – skipping second launch`);
            state.botStatuses[botNumber] = BotStatus.RUNNING;
            this.broadcastBotStatus(botNumber);
            return this.processes.get(botNumber)?.process || true;
        }
        // Ensure common junction exists
        this.ensureSteamappsJunction(botNumber);

        // Ensure Source Engine mutexes are cleared before attempting the launch
        this.releaseSourceEngineMutexes();

        // Update bot status
        state.botStatuses[botNumber] = BotStatus.TF2_STARTING;
        this.broadcastBotStatus(botNumber);

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

            // Run mutex cleanup again shortly after launch – this enables subsequent
            // bot instances to start even while the current one is running.
            setTimeout(() => {
                this.releaseSourceEngineMutexes();
            }, 5000);

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

    // Start TF2 process scanner for rogue processes
    startTF2ProcessScanner() {
        if (this.tf2ScannerInterval) {
            clearInterval(this.tf2ScannerInterval);
        }
        
        // Scan every 10 seconds for rogue TF2 processes
        this.tf2ScannerInterval = setInterval(() => {
            this.scanAndTerminateRogueTF2Processes();
        }, 10000);
        
        logger.info('TF2 Process Scanner started - will terminate TF2 processes without -textmode');
    }
    
    // Stop TF2 process scanner
    stopTF2ProcessScanner() {
        if (this.tf2ScannerInterval) {
            clearInterval(this.tf2ScannerInterval);
            this.tf2ScannerInterval = null;
            logger.info('TF2 Process Scanner stopped');
        }
    }
    
    // Scan for and terminate TF2 processes that don't have -textmode argument
    async scanAndTerminateRogueTF2Processes() {
        // Skip if scanning is disabled in config
        if (state.config.disableTF2Scanner === true) {
            return;
        }
        
        // Throttle scanning - don't scan more than once every 5 seconds
        const now = Date.now();
        if (now - this.lastTF2ScanTime < 5000) {
            return;
        }
        this.lastTF2ScanTime = now;
        
        try {
            logger.debug('Scanning for rogue TF2 processes...');
            
            // Get all tf_win64.exe processes with their command lines using PowerShell
            const psCommand = `powershell -NoProfile -Command "Get-CimInstance -ClassName Win32_Process -Filter \\"Name='tf_win64.exe'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json"`;
            
            const { exec } = require('child_process');
            exec(psCommand, { timeout: 5000 }, (error, stdout, stderr) => {
                if (error) {
                    logger.debug(`TF2 scanner error: ${error.message}`);
                    return;
                }
                
                try {
                    let processes = [];
                    if (stdout.trim()) {
                        const result = JSON.parse(stdout);
                        processes = Array.isArray(result) ? result : [result];
                    }
                    
                    if (processes.length === 0) {
                        logger.debug('No TF2 processes found during scan');
                        return;
                    }
                    
                    logger.debug(`Found ${processes.length} TF2 process(es) during scan`);
                    
                    let terminatedCount = 0;
                    let roguePIDs = [];
                    
                    for (const proc of processes) {
                        const pid = proc.ProcessId;
                        const cmdLine = proc.CommandLine || '';
                        
                        // Check if this process has -textmode argument
                        const hasTextmode = cmdLine.toLowerCase().includes('-textmode');
                        
                        if (!hasTextmode) {
                            logger.warn(`🚨 ROGUE TF2 DETECTED: PID ${pid} without -textmode`);
                            logger.warn(`Command line: ${cmdLine}`);
                            
                            roguePIDs.push(pid);
                            
                            // Terminate the rogue process
                            exec(`taskkill /F /PID ${pid}`, (killError) => {
                                if (killError) {
                                    logger.error(`Failed to terminate rogue TF2 PID ${pid}: ${killError.message}`);
                                } else {
                                    logger.warn(`✅ TERMINATED rogue TF2 process PID ${pid}`);
                                    terminatedCount++;
                                    
                                    if (this.io) {
                                        this.io.emit('logMessage', `🚨 Terminated rogue TF2 process PID ${pid} (no -textmode)`);
                                    }
                                }
                            });
                        } else {
                            // This is a legitimate bot process
                            logger.debug(`✅ Legitimate TF2 process: PID ${pid} (has -textmode)`);
                        }
                    }
                    
                    if (roguePIDs.length > 0) {
                        logger.warn(`TF2 Scanner: Found ${roguePIDs.length} rogue processes, terminating: ${roguePIDs.join(', ')}`);
                        
                        if (this.io) {
                            this.io.emit('logMessage', `TF2 Scanner: Terminated ${roguePIDs.length} rogue TF2 process(es) without -textmode`);
                        }
                    } else {
                        logger.debug('TF2 Scanner: All TF2 processes are legitimate (have -textmode)');
                    }
                    
                } catch (parseError) {
                    logger.debug(`TF2 scanner parse error: ${parseError.message}`);
                }
            });
            
        } catch (err) {
            logger.error(`TF2 scanner error: ${err.message}`);
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
        
        // Stop TF2 scanner
        this.stopTF2ProcessScanner();
        
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

    // Toggle TF2 scanner functionality
    toggleTF2Scanner(enabled) {
        state.config.disableTF2Scanner = !enabled;
        logger.info(`TF2 Process Scanner ${enabled ? 'enabled' : 'disabled'}`);
        
        // Save the setting to config
        state.saveConfig();
        
        if (enabled) {
            this.startTF2ProcessScanner();
        } else {
            this.stopTF2ProcessScanner();
        }
        
        // Broadcast updated state to clients
        if (this.io) {
            this.io.emit('logMessage', `TF2 Process Scanner ${enabled ? 'enabled' : 'disabled'}`);
        }
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
    ensureSteamappsJunction(botNumber) {
        try {
            const instanceDir = state.instances.get(botNumber);
            if (!instanceDir) return;
            const mainSteamRoot = path.dirname(state.config.steamPath);
            const mainSteamapps = path.join(mainSteamRoot, 'steamapps');
            const instanceSteamDir = path.join(instanceDir, 'steam');
            const destSteamapps = path.join(instanceSteamDir, 'steamapps');

            // Ensure instance 'steam' directory exists
            if (!fs.existsSync(instanceSteamDir)) {
                fs.mkdirSync(instanceSteamDir, { recursive: true });
            }

            let needsLink = true;
            if (fs.existsSync(destSteamapps)) {
                if (fs.lstatSync(destSteamapps).isSymbolicLink()) {
                    needsLink = false;
                } else {
                    logger.warn(`Instance for bot ${botNumber} has a real steamapps directory, removing it to create a junction.`);
                    fs.rmSync(destSteamapps, { recursive: true, force: true });
                }
            }

            if (needsLink) {
                if (fs.existsSync(mainSteamapps)) {
                    fs.symlinkSync(mainSteamapps, destSteamapps, 'junction');
                    logger.info(`Created/repaired steamapps junction for bot ${botNumber}`);
                } else {
                    logger.warn(`Main steamapps directory not found at ${mainSteamapps}. Skipping junction creation.`);
                }
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
            
            // Create proper localconfig.vdf structure based on user's file
            const newContent = `"UserLocalConfigStore"
{
	"Broadcast"
	{
		"Permissions"		"0"
	}
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"apps"
				{
					"440"
					{
						"LaunchOptions"		"${sanitized}"
						"cloud"
						{
							"last_sync_state"		"synchronized"
						}
						"autocloud"
						{
							"lastlaunch"		"0"
							"lastexit"		"0"
						}
					}
				}
			}
		}
	}
	"system"
	{
		"EnableGameOverlay"		"0"
		"PushToTalkKey"		"0"
	}
}`;

            // Find all user ID directories and write localconfig.vdf
            const idDirs = fs.readdirSync(userdataRoot).filter(d => {
                try {
                    return fs.lstatSync(path.join(userdataRoot, d)).isDirectory() && /^\d+$/.test(d);
                } catch (_) {
                    return false;
                }
            });

            if (idDirs.length === 0) {
                // Create a dummy user ID directory if none exist
                const dummyId = '1000000000';
                const dummyDir = path.join(userdataRoot, dummyId);
                fs.mkdirSync(dummyDir, { recursive: true });
                idDirs.push(dummyId);
                logger.info(`Created dummy user directory for bot ${botNumber}: ${dummyId}`);
            }

            let successCount = 0;
            let totalFiles = 0;

            idDirs.forEach(id => {
                const configDir = path.join(userdataRoot, id, 'config');
                try {
                    fs.mkdirSync(configDir, { recursive: true });
                    
                    // Write main localconfig.vdf
                    const configPath = path.join(configDir, 'localconfig.vdf');
                    fs.writeFileSync(configPath, newContent);
                    totalFiles++;
                    
                    // Verify it was written correctly
                    try {
                        const verification = fs.readFileSync(configPath, 'utf8');
                        if (verification.includes(sanitized)) {
                            successCount++;
                        }
                    } catch (_) {}

                    // Create multiple backups with different names
                    const backupNames = [
                        'localconfig_backup.vdf',
                        'localconfig_bot.vdf', 
                        `localconfig_bot${botNumber}.vdf`,
                        'localconfig_protected.vdf'
                    ];
                    
                    backupNames.forEach(backupName => {
                        try {
                            const backupPath = path.join(configDir, backupName);
                            fs.writeFileSync(backupPath, newContent);
                            totalFiles++;
                        } catch (_) {}
                    });
                    
                    // Also write to subdirectories in case Steam looks there
                    const subDirs = ['7', '440', 'remote'];
                    subDirs.forEach(subDir => {
                        try {
                            const subConfigDir = path.join(configDir, subDir);
                            fs.mkdirSync(subConfigDir, { recursive: true });
                            const subConfigPath = path.join(subConfigDir, 'localconfig.vdf');
                            fs.writeFileSync(subConfigPath, newContent);
                            totalFiles++;
                        } catch (_) {}
                    });
                    
                } catch (e) {
                    logger.debug(`Error writing localconfig for bot ${botNumber}, user ${id}: ${e.message}`);
                }
            });

            // Also ensure Steam Cloud is disabled in sharedconfig.vdf files
            this.disableSharedConfigCloud(botNumber);

            // Log success rate periodically
            const timestamp = Date.now();
            if (!this.lastLogTime) this.lastLogTime = {};
            if (!this.lastLogTime[botNumber] || timestamp - this.lastLogTime[botNumber] > 10000) {
                logger.info(`Launch options protection for bot ${botNumber}: ${successCount}/${idDirs.length} verified, ${totalFiles} total files written`);
                this.lastLogTime[botNumber] = timestamp;
            }
            
            return successCount > 0;
        } catch (err) {
            logger.error(`setTF2LaunchOptions error for bot ${botNumber}: ${err.message}`);
            return false;
        }
    }

    // Periodically attempts to write localconfig until success or timeout
    scheduleLocalConfigUpdate(botNumber, launchOptionsString) {
        // Clear any existing scheduled task for this bot
        if (this.localConfigIntervals.has(botNumber)) {
            clearInterval(this.localConfigIntervals.get(botNumber));
        }

        logger.info(`Starting AGGRESSIVE localconfig monitoring for bot ${botNumber}`);
        let writeCount = 0;

        const interval = setInterval(() => {
            writeCount++;
            
            // Stop once the bot has reached ACTIVE status and we've written at least 20 times
            const currentStatus = state.botStatuses[botNumber];
            if (currentStatus === BotStatus.ACTIVE && writeCount >= 20) {
                clearInterval(interval);
                this.localConfigIntervals.delete(botNumber);
                logger.info(`Stopped aggressive localconfig monitoring for bot ${botNumber} after ${writeCount} writes (status = ${currentStatus})`);
                return;
            }
            
            // Stop if bot fails or after 2 minutes of trying
            if (writeCount > 240 || (currentStatus && [BotStatus.CRASHED, BotStatus.STOPPED].includes(currentStatus))) {
                clearInterval(interval);
                this.localConfigIntervals.delete(botNumber);
                logger.warn(`Stopped localconfig monitoring for bot ${botNumber} - bot failed or timeout (writes: ${writeCount})`);
                return;
            }

            try {
                // AGGRESSIVELY write launch options every 500ms
                this.setTF2LaunchOptions(botNumber, launchOptionsString);
                this.writeSteamConfigLaunchOptions(botNumber, launchOptionsString);
                
                // Log every 10th write to avoid spam
                if (writeCount % 10 === 0) {
                    logger.info(`Aggressive localconfig write #${writeCount} for bot ${botNumber} (status: ${currentStatus})`);
                }

                // Verify launch options are actually written correctly
                const instanceDir = state.instances.get(botNumber);
                if (!instanceDir) return;
                
                const userdataRoot = path.join(instanceDir, 'steam', 'userdata');
                if (fs.existsSync(userdataRoot)) {
                    let foundCorrectOptions = false;
                    const targetOptions = launchOptionsString.replace(/"/g, '');
                    
                    // Check if any localconfig.vdf contains our launch options
                    const checkConfigFiles = (dir) => {
                        try {
                            const entries = fs.readdirSync(dir, { withFileTypes: true });
                            for (const e of entries) {
                                const fp = path.join(dir, e.name);
                                if (e.isDirectory()) {
                                    checkConfigFiles(fp);
                                } else if (e.isFile() && e.name.toLowerCase() === 'localconfig.vdf') {
                                    try {
                                        const content = fs.readFileSync(fp, 'utf8');
                                        if (content.includes(targetOptions)) {
                                            foundCorrectOptions = true;
                                        }
                                    } catch (_) {}
                                }
                            }
                        } catch(_) {}
                    };
                    
                    checkConfigFiles(userdataRoot);
                    
                    if (foundCorrectOptions && writeCount % 20 === 0) {
                        logger.info(`✓ Launch options verified in localconfig.vdf for bot ${botNumber}`);
                    } else if (!foundCorrectOptions && writeCount % 5 === 0) {
                        logger.warn(`✗ Launch options NOT found in localconfig.vdf for bot ${botNumber} - continuing writes...`);
                    }
                }
            } catch (err) {
                logger.debug(`Aggressive localconfig write error for bot ${botNumber}: ${err.message}`);
            }
        }, 500); // Write every 500ms

        this.localConfigIntervals.set(botNumber, interval);
        logger.info(`Started aggressive localconfig interval for bot ${botNumber}`);
    }

    // Build array of default TF2 launch arguments for given bot
    getTF2LaunchArgs(botNumber) {
        // Default launch arguments that should always be included for bot operation
        const defaultArgs = [
            '-steam',
            '-steamipcname', `steam_bot_${botNumber}`,
            '-sw',
            '-w 1',
            '-h 480',
            '-x 30000',
            '-y 30000',
            '-novid',
            '-nojoy',
            '-noipx',
            '-noshaderapi',
            '-nomouse',
            '-nomessagebox',
            '-nominidumps',
            '-nohltv',
            '-low',
            '-threads 1',
            '-nobreakpad',
            '-reuse',
            '-skipupdate',
            '-noquicktime',
            '-precachefontchars',
            '-particles 1',
            '-textmode',
            '-snoforceformat',
            '-softparticlesdefaultoff',
            '-wavonly',
            '-forcenovsync'
        ];

        // User-configurable launch options from config
        let userArgs = [];
        if (state.config.tf2LaunchOptions) {
            // Parse user's launch options string into array
            userArgs = state.config.tf2LaunchOptions.split(' ').filter(arg => arg.trim().length > 0);
        } else {
            // If not configured, no additional user args (all defaults above)
            userArgs = [];
        }

        // Combine default args with user args, removing duplicates
        const allArgs = [...defaultArgs];
        
        // Add user args that don't conflict with default args
        userArgs.forEach(arg => {
            const argName = arg.startsWith('-') ? arg : `-${arg}`;
            // Don't add if it conflicts with required bot args
            const conflicts = ['-steam', '-steamipcname', '-textmode'];
            const isConflict = conflicts.some(conflict => argName.startsWith(conflict));
            
            if (!isConflict && !allArgs.includes(argName)) {
                allArgs.push(argName);
            }
        });

        logger.debug(`Generated TF2 launch args for bot ${botNumber}: ${allArgs.join(' ')}`);
        return allArgs;
    }

    // Write launch options into steam/config/config.vdf before Steam starts
    writeSteamConfigLaunchOptions(botNumber, launchOptionsString) {
        try {
            const instanceDir = state.instances.get(botNumber);
            if (!instanceDir) return;

            const cfgDir = path.join(instanceDir, 'steam', 'config');
            fs.mkdirSync(cfgDir, { recursive: true });

            const sanitized = launchOptionsString.replace(/"/g, '');
            const content = `"InstallConfigStore"
{
    "Software"
    {
        "Valve"
        {
            "Steam"
            {
                "Broadcast"
                {
                    "Permissions"		"0"
                }
                "apps"
                {
                    "440"
                    {
                        "LaunchOptions"		"${sanitized}"
                        "AllowSkipGameUpdate"		"1"
                        "DisableOverlay"		"1"
                        "DisableCloudSync"		"1"
                    }
                }
            }
        }
    }
}`;

            // Write main config file
            const cfgPath = path.join(cfgDir, 'config.vdf');
            fs.writeFileSync(cfgPath, content);

            // Create multiple backup files to protect against overwriting
            const backupFiles = [
                'config_backup.vdf',
                'config_bot.vdf',
                `config_bot${botNumber}.vdf`,
                'config_protected.vdf',
                'loginusers.vdf',  // Steam sometimes reads this
                'InstallConfigStore.vdf'
            ];

            let backupCount = 0;
            backupFiles.forEach(fileName => {
                try {
                    const backupPath = path.join(cfgDir, fileName);
                    fs.writeFileSync(backupPath, content);
                    backupCount++;
                } catch (_) {}
            });

            // Also write to subdirectories
            const subDirs = ['backup', 'apps', '440'];
            subDirs.forEach(subDir => {
                try {
                    const subCfgDir = path.join(cfgDir, subDir);
                    fs.mkdirSync(subCfgDir, { recursive: true });
                    const subCfgPath = path.join(subCfgDir, 'config.vdf');
                    fs.writeFileSync(subCfgPath, content);
                    backupCount++;
                } catch (_) {}
            });

            logger.debug(`Steam config protection for bot ${botNumber}: ${backupCount} backup files created`);
            return true;
        } catch (err) {
            logger.warn(`writeSteamConfigLaunchOptions failed for bot ${botNumber}: ${err.message}`);
            return false;
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