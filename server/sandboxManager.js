const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { state, BotStatus } = require('../shared/state');

// Sandboxie manager for handling sandboxed TF2 instances
class SandboxManager {
    constructor() {
        // Validate Sandboxie installation on initialization
        this.validateSandboxiePath();

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
        this.startProcessMonitoring();
        
        // Store IO reference for status updates
        this.io = null;
    }
    
    // Set the Socket.IO instance for real-time updates
    setIO(io) {
        this.io = io;
    }

    // Validate the Sandboxie path
    validateSandboxiePath() {
        const sandboxiePath = state.config.sandboxiePath;
        
        if (!sandboxiePath || !fs.existsSync(sandboxiePath)) {
            logger.error(`Sandboxie not found at configured path: ${sandboxiePath}`);
            return false;
        }
        
        logger.info(`Sandboxie found at: ${sandboxiePath}`);
        return true;
    }
    
    // Create a new sandbox for a bot
    createSandbox(botNumber) {
        const sandboxName = `bot${botNumber}`;
        
        try {
            // Check if sandbox already exists
            this.getSandboxList((err, sandboxes) => {
                if (err) {
                    logger.error(`Error checking existing sandboxes: ${err.message}`);
                    return false;
                }
                
                // If sandbox already exists, use it (don't recreate or delete)
                if (sandboxes.includes(sandboxName)) {
                    logger.info(`Using existing sandbox ${sandboxName}`);
                    
                    // Store reference to the sandbox
                    state.sandboxes.set(botNumber, sandboxName);
                    return true;
                }
                
                // If sandbox doesn't exist, create a new one
                logger.info(`Sandbox ${sandboxName} not found, creating new one`);
                const sandboxiePath = state.config.sandboxiePath;
                const sandboxieDir = path.dirname(sandboxiePath);
                const sbiectlPath = path.join(sandboxieDir, 'SbieCtrl.exe');
                
                // Use SbieCtrl to create the sandbox with proper settings
                exec(`"${sbiectlPath}" /box:${sandboxName} create`, (error) => {
                    if (error) {
                        logger.error(`Failed to create sandbox ${sandboxName}: ${error.message}`);
                        return false;
                    }
                    
                    logger.info(`Created sandbox ${sandboxName}`);
                    
                    // Apply default settings to the sandbox
                    this.configureSandbox(sandboxName);
                    
                    // Store reference to the sandbox
                    state.sandboxes.set(botNumber, sandboxName);
                    
                    return true;
                });
            });
            
            // Consider sandbox creation successful
            // The actual creation happens asynchronously and we'll handle errors later if needed
            return true;
        } catch (err) {
            logger.error(`Error creating sandbox for bot ${botNumber}: ${err.message}`);
            return false;
        }
    }
    
    // Configure a sandbox with appropriate settings
    configureSandbox(sandboxName) {
        try {
            const sandboxiePath = state.config.sandboxiePath;
            const sandboxieDir = path.dirname(sandboxiePath);
            const sbiectlPath = path.join(sandboxieDir, 'SbieCtrl.exe');
            
            // Apply settings for TF2 compatibility
            const settings = [
                // Allow network access
                `/box:${sandboxName} set AllowNetworkAccess y`,
                // Drop rights
                `/box:${sandboxName} set DropAdminRights y`,
                // OpenGL/DirectX support
                `/box:${sandboxName} set OpenGlHardwareAcceleration y`,
                // Allow shared access to Steam
                `/box:${sandboxName} set OpenFilePath "C:\\Program Files (x86)\\Steam\\*"`,
                // Allow access to Steam libraries
                `/box:${sandboxName} set OpenFilePath "C:\\Program Files (x86)\\Steam\\steamapps\\*"`,
                // Allow access to Steam user data
                `/box:${sandboxName} set OpenFilePath "C:\\Program Files (x86)\\Steam\\userdata\\*"`,
                // Allow access to Steam workshop data
                `/box:${sandboxName} set OpenFilePath "C:\\Program Files (x86)\\Steam\\workshop\\*"`
            ];
            
            // Apply each setting
            for (const setting of settings) {
                exec(`"${sbiectlPath}" ${setting}`, (error) => {
                    if (error) {
                        logger.error(`Failed to apply setting to sandbox ${sandboxName}: ${setting} - ${error.message}`);
                    }
                });
            }
            
            logger.info(`Configured sandbox ${sandboxName} with TF2 settings`);
            return true;
        } catch (err) {
            logger.error(`Error configuring sandbox ${sandboxName}: ${err.message}`);
            return false;
        }
    }
    
    // Delete a sandbox
    deleteSandbox(sandboxName) {
        try {
            const sandboxiePath = state.config.sandboxiePath;
            const sandboxieDir = path.dirname(sandboxiePath);
            const sbiectlPath = path.join(sandboxieDir, 'SbieCtrl.exe');
            
            // Use SbieCtrl to delete the sandbox
            exec(`"${sbiectlPath}" /box:${sandboxName} delete`, (error) => {
                if (error) {
                    logger.error(`Failed to delete sandbox ${sandboxName}: ${error.message}`);
                    return false;
                }
                
                logger.info(`Deleted sandbox ${sandboxName}`);
                return true;
            });
        } catch (err) {
            logger.error(`Error deleting sandbox ${sandboxName}: ${err.message}`);
            return false;
        }
    }
    
    // Launch a program in the sandbox
    launchInSandbox(botNumber, program, args = [], isBackground = true) {
        // Get the sandbox name for this bot
        const sandboxName = state.sandboxes.get(botNumber) || `bot${botNumber}`;
        
        // NEW: Prepare environment variable for the bot ID so the in-game DLL can read it reliably
        const envArg = `/env:BOTID=${botNumber}`;
        
        try {
            const sandboxiePath = state.config.sandboxiePath;
            
            // Build the command to launch with Sandboxie
            let command;
            if (isBackground) {
                // Properly escape quotes for Windows cmd
                // Using /min to minimize the window instead of hiding it completely
                const argsStr = args.join(' ');
                command = `"${sandboxiePath}" /box:${sandboxName} ${envArg} cmd /c start /min "" "${program}" ${argsStr}`;
            } else {
                command = `"${sandboxiePath}" /box:${sandboxName} ${envArg} "${program}" ${args.join(' ')}`;
            }
            
            logger.info(`Launching in sandbox ${sandboxName}: ${program} ${args.join(' ')}`);
            
            // Emit log message
            if (this.io) {
                this.io.emit('logMessage', `Launching ${path.basename(program)} for bot ${botNumber}${isBackground ? ' (background)' : ''}`);
            }
            
            // Execute the sandboxed process
            const process = exec(command, (error) => {
                if (error) {
                    logger.error(`Error running in sandbox ${sandboxName}: ${error.message}`);
                    
                    // Update status to reflect error
                    if (program.includes('tf_win64.exe')) {
                        state.botStatuses[botNumber] = BotStatus.TF2_ERROR;
                    } else if (program.includes('steam.exe')) {
                        state.botStatuses[botNumber] = BotStatus.STEAM_ERROR;
                    } else {
                        state.botStatuses[botNumber] = BotStatus.CRASHED;
                    }
                    
                    // Broadcast the status update
                    this.broadcastBotStatus(botNumber);
                    
                    // If error occurs and auto-restart is enabled, handle process failure
                    if (state.autoRestartEnabled && !state.restartingBots.has(botNumber)) {
                        this.handleProcessFailure(botNumber, program);
                    }
                    
                    return false;
                }
            });
            
            // Store process reference for monitoring
            if (process) {
                this.processes.set(botNumber, {
                    process,
                    program,
                    args,
                    timestamp: Date.now(),
                    isBackground
                });
                
                // If this is TF2, update the status to reflect it's running
                if (program.includes('tf_win64.exe')) {
                    state.botStatuses[botNumber] = BotStatus.RUNNING;
                    this.broadcastBotStatus(botNumber);
                }
            }
            
            return process;
        } catch (err) {
            logger.error(`Error launching program in sandbox for bot ${botNumber}: ${err.message}`);
            
            // Update status to reflect error
            if (program.includes('tf_win64.exe')) {
                state.botStatuses[botNumber] = BotStatus.TF2_ERROR;
            } else if (program.includes('steam.exe')) {
                state.botStatuses[botNumber] = BotStatus.STEAM_ERROR;
            } else {
                state.botStatuses[botNumber] = BotStatus.CRASHED;
            }
            
            // Broadcast the status update
            this.broadcastBotStatus(botNumber);
            
            return null;
        }
    }
    
    // Launch VAC Bypass instead of Steam
    launchVacBypass(botNumber, account) {
        const vacBypassPath = this.filePaths.vacBypassLoader;
        
        if (!vacBypassPath || !fs.existsSync(vacBypassPath)) {
            logger.error(`VAC Bypass Loader not found at: ${vacBypassPath}`);
            return false;
        }
        
        // Update bot status
        state.botStatuses[botNumber] = BotStatus.VAC_BYPASS_LOADING;
        
        // Check if account info is provided
        if (!account || !account.username || !account.password) {
            logger.error(`No valid account provided for bot ${botNumber}`);
            return Promise.reject(new Error('No valid account provided'));
        }
        
        // Launch VAC Bypass Loader in the sandbox with elevated privileges and account info
        const sandboxName = state.sandboxes.get(botNumber) || `bot${botNumber}`;
        
        // Fix command format: Don't use cmd /c with /elevate as it may cause issues
        // Using direct invocation with proper quoting
        const vacBypassCommand = `"${state.config.sandboxiePath}" /box:${sandboxName} /elevate "${vacBypassPath}" ${account.username} ${account.password} -nobrowser`;
        
        logger.info(`Launching VAC Bypass for bot ${botNumber} with account ${account.username}`);
        
        return new Promise((resolve, reject) => {
            exec(vacBypassCommand, (error, stdout, stderr) => {
                if (error) {
                    logger.error(`Error running VAC bypass: ${error.message}`);
                    logger.error(`VAC bypass stderr: ${stderr}`);
                    state.botStatuses[botNumber] = BotStatus.VAC_BYPASS_ERROR;
                    reject(false);
                    return;
                }
                
                logger.info(`VAC bypass output: ${stdout}`);
                state.botStatuses[botNumber] = BotStatus.VAC_BYPASS_LOADED;
                logger.info(`VAC bypass loaded, waiting for initialization to complete`);
                setTimeout(() => {
                    resolve(true);
                }, 20000);
            });
        });
    }
    
    // Create bot identification files
    createBotFile(sandboxName, botNumber) {
        const botFileName = `bot${botNumber}.txt`;
        const tf2FolderPath = path.dirname(state.config.tf2Path);
        
        // Create file in sandboxed TF2 folder
        const createSandboxFileCommand = `"${state.config.sandboxiePath}" /box:${sandboxName} cmd /c "echo Bot ${botNumber} initialized > "${tf2FolderPath}\\${botFileName}""`;
        
        // Create file in sandboxed %APPDATA%/Amalgam folder - each bot will only see its own file
        const createSandboxedAmalgamFileCommand = `"${state.config.sandboxiePath}" /box:${sandboxName} cmd /c "if not exist "%APPDATA%\\Amalgam" mkdir "%APPDATA%\\Amalgam" && echo Bot ${botNumber} initialized > "%APPDATA%\\Amalgam\\${botFileName}""`;
        
        try {
            exec(createSandboxFileCommand, (error, stdout, stderr) => {
                if (error) {
                    logger.error(`Error creating ${botFileName} in sandbox: ${error.message}`);
                    return;
                }
                logger.info(`Created ${botFileName} in the sandboxed Team Fortress 2 folder at ${tf2FolderPath}`);
            });
            
            // Create file in sandboxed %APPDATA%/Amalgam
            exec(createSandboxedAmalgamFileCommand, (error, stdout, stderr) => {
                if (error) {
                    logger.error(`Error creating ${botFileName} in sandboxed Amalgam folder: ${error.message}`);
                    return;
                }
                logger.info(`Created ${botFileName} in the sandboxed Amalgam folder for bot ${botNumber}`);
            });
        } catch (error) {
            logger.error(`Error creating ${botFileName}: ${error.message}`);
        }
    }
    
    // Launch TF2 in the sandbox
    launchTF2(botNumber, isBackground = true) {
        const tf2Path = state.config.tf2Path;
        
        if (!tf2Path || !fs.existsSync(tf2Path)) {
            logger.error(`TF2 not found at configured path: ${tf2Path}`);
            state.botStatuses[botNumber] = BotStatus.TF2_ERROR;
            this.broadcastBotStatus(botNumber);
            return false;
        }
        
        // Update bot status
        state.botStatuses[botNumber] = BotStatus.TF2_STARTING;
        this.broadcastBotStatus(botNumber);
        
        // Create bot identification files
        const sandboxName = state.sandboxes.get(botNumber) || `bot${botNumber}`;
        this.createBotFile(sandboxName, botNumber);
        
       // Launch TF2 in the sandbox with neptune-friendly launch options
       const launchOptions = [
        '-steam',
        '-noshaderapi',
        '-nohltv',
        '-nomouse',
        '-nomessagebox',
        '-nominidumps',
        '-nohltv',
        '-nobreakpad',
        '-reuse',
        '-noquicktime',
        '-precachefontchars',
        '-particles 1',
        '-snoforceformat',
        '-softparticlesdefaultoff',
        '-wavonly',
        '-forcenovsync',
        '-w 1',
        '-h 480',
	'-small',
	'-windowed',
	'-noborder',
        '-novid',
        '-nojoy',
        '-nosteamcontroller',
        '-nocrashdialog',
        '-game tf',
        '-port 69',
        '+port 69',
        '+tv_port 70',
        '-tv_port 70',
        '-noipx',
        '-threads 1',
        '-textmode',
        '-nostartupsound',
        '-nocdaudio',
        '-noaudio',
	'-forcepreload',
        '-nocrashdialog'
    ];
        
        const process = this.launchInSandbox(botNumber, tf2Path, launchOptions, isBackground);
        
        // Register TF2 process for crash detection
        if (process) {
            // Store process reference for auto-restart monitoring
            this.processes.set(botNumber, {
                process,
                program: tf2Path,
                args: launchOptions,
                timestamp: Date.now(),
                type: 'tf2',
                isBackground
            });
            
            // Update status to RUNNING once process started
            state.botStatuses[botNumber] = BotStatus.RUNNING;
            this.broadcastBotStatus(botNumber);
            
            if (this.io) {
                this.io.emit('logMessage', `TF2 started for bot ${botNumber}`);
            }
        } else {
            // Update status to ERROR if process couldn't start
            state.botStatuses[botNumber] = BotStatus.TF2_ERROR;
            this.broadcastBotStatus(botNumber);
            
            if (this.io) {
                this.io.emit('logMessage', `Failed to start TF2 for bot ${botNumber}`);
            }
        }
        
        return process;
    }
    
    // Get list of all sandboxes
    getSandboxList(callback) {
        try {
            const sandboxiePath = state.config.sandboxiePath;
            const sandboxieDir = path.dirname(sandboxiePath);
            const sbiectlPath = path.join(sandboxieDir, 'SbieCtrl.exe');
            
            // Use SbieCtrl to list sandboxes
            exec(`"${sbiectlPath}" /listboxes`, (error, stdout) => {
                if (error) {
                    logger.error(`Failed to list sandboxes: ${error.message}`);
                    callback(error, []);
                    return;
                }
                
                // Parse output to get sandbox names
                const sandboxes = stdout.trim().split('\n')
                    .map(line => line.trim())
                    .filter(line => line && line !== 'DefaultBox'); // Filter out empty lines and DefaultBox
                
                callback(null, sandboxes);
            });
        } catch (err) {
            logger.error(`Error getting sandbox list: ${err.message}`);
            callback(err, []);
        }
    }
    
    // Terminate all processes in a sandbox
    terminateSandboxProcesses(sandboxName) {
        return new Promise(async (resolve) => {
            try {
                const sandboxiePath = state.config.sandboxiePath;
                const sandboxieDir = path.dirname(sandboxiePath);
                const sbiectlPath = path.join(sandboxieDir, 'SbieCtrl.exe');
                
                logger.info(`Forcefully terminating all processes in sandbox ${sandboxName}...`);
                
                // First attempt: Direct taskkill commands inside the sandbox for known processes
                // This is more aggressive than just using the SbieCtrl terminate command
                const taskkillCommands = [
                    // Kill Steam processes with /F (force)
                    `"${sandboxiePath}" /box:${sandboxName} cmd /c "taskkill /F /IM steam.exe"`,
                    `"${sandboxiePath}" /box:${sandboxName} cmd /c "taskkill /F /IM steamwebhelper.exe"`,
                    // Kill TF2
                    `"${sandboxiePath}" /box:${sandboxName} cmd /c "taskkill /F /IM tf_win64.exe"`,
                    `"${sandboxiePath}" /box:${sandboxName} cmd /c "taskkill /F /IM hl2.exe"`,
                    // Kill our injection tools
                    `"${sandboxiePath}" /box:${sandboxName} cmd /c "taskkill /F /IM attach.exe"`,
                    `"${sandboxiePath}" /box:${sandboxName} cmd /c "taskkill /F /IM VAC-Bypass-Loader.exe"`,
                    // Kill any cmd processes
                    `"${sandboxiePath}" /box:${sandboxName} cmd /c "taskkill /F /IM cmd.exe"`,
                    // Kill ANY remaining process (wildcard)
                    `"${sandboxiePath}" /box:${sandboxName} cmd /c "taskkill /F /IM *.*"`
                ];
                
                // Run each taskkill command but don't wait for results
                for (const cmd of taskkillCommands) {
                    try {
                        exec(cmd);
                    } catch (err) {
                        // Ignore errors - some processes might not exist
                    }
                }
                
                // Wait a bit for the taskkill commands to take effect
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Second attempt: Use SbieCtrl terminate command (try multiple times)
                const maxRetries = 3;
                let success = false;
                
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        logger.info(`Running Sandboxie terminate (attempt ${attempt}/${maxRetries})...`);
                        
                        // Execute the terminate command and wait for it to complete
                        await new Promise((resolveExec, rejectExec) => {
                            exec(`"${sbiectlPath}" /box:${sandboxName} terminate`, (error, stdout, stderr) => {
                                if (error) {
                                    logger.error(`Terminate command error (attempt ${attempt}): ${error.message}`);
                                    resolveExec(false);
                                } else {
                                    logger.info(`Terminate command completed (attempt ${attempt})`);
                                    resolveExec(true);
                                }
                            });
                        });
                        
                        // Wait a bit after each attempt
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        
                        // Check if any processes are still running in the sandbox
                        const processCheckResult = await new Promise((resolveCheck) => {
                            exec(`"${sbiectlPath}" /box:${sandboxName} process`, (error, stdout) => {
                                if (error) {
                                    // If we can't check, assume it worked
                                    resolveCheck({ success: true, output: "" });
                                    return;
                                }
                                
                                const hasProcesses = stdout && 
                                                   stdout.trim() && 
                                                   !stdout.includes('No processes') &&
                                                   !stdout.includes('not found');
                                
                                resolveCheck({ 
                                    success: !hasProcesses,
                                    output: stdout
                                });
                            });
                        });
                        
                        if (processCheckResult.success) {
                            logger.info(`All processes terminated successfully in sandbox ${sandboxName}`);
                            success = true;
                            break;
                        } else {
                            // Log what processes are still running
                            logger.warn(`Some processes still running in sandbox ${sandboxName} after attempt ${attempt}:`);
                            logger.warn(processCheckResult.output);
                            
                            // Try even more aggressive termination if this isn't the last attempt
                            if (attempt < maxRetries) {
                                // Use the box delete then recreate approach as a last resort
                                if (attempt === maxRetries - 1) {
                                    try {
                                        logger.info(`Trying emergency box delete for ${sandboxName}...`);
                                        await new Promise(resolveEmergency => {
                                            exec(`"${sbiectlPath}" /box:${sandboxName} delete /silent`, () => {
                                                // Recreate the box immediately
                                                exec(`"${sbiectlPath}" /box:${sandboxName} create`, () => {
                                                    resolveEmergency();
                                                });
                                            });
                                        });
                                    } catch (emergencyErr) {
                                        logger.error(`Emergency delete/create failed: ${emergencyErr.message}`);
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        logger.error(`Error during termination attempt ${attempt}: ${err.message}`);
                    }
                    
                    // Short delay between attempts
                    if (attempt < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
                
                // Final verification - try to get a list of processes still running
                try {
                    const finalCheck = await new Promise((resolveCheck) => {
                        exec(`"${sbiectlPath}" /box:${sandboxName} process`, (error, stdout) => {
                            if (error) {
                                resolveCheck({ success: true, output: "Unable to check processes" });
                                return;
                            }
                            
                            const hasProcesses = stdout && 
                                               stdout.trim() && 
                                               !stdout.includes('No processes') &&
                                               !stdout.includes('not found');
                            
                            resolveCheck({ 
                                success: !hasProcesses,
                                output: stdout.trim()
                            });
                        });
                    });
                    
                    if (!finalCheck.success) {
                        logger.error(`Failed to terminate all processes in sandbox ${sandboxName}. Processes still running:`);
                        logger.error(finalCheck.output);
                        
                        // Final emergency attempt - use taskkill with the /T flag to kill process trees
                        const emergencyCommand = `"${sandboxiePath}" /box:${sandboxName} cmd /c "taskkill /F /T /IM *.*"`;
                        exec(emergencyCommand);
                    }
                } catch (finalErr) {
                    logger.error(`Final verification error: ${finalErr.message}`);
                }
                
                resolve(success);
            } catch (err) {
                logger.error(`Critical error terminating processes in sandbox ${sandboxName}: ${err.message}`);
                resolve(false);
            }
        });
    }
    
    // Stop a bot by terminating its sandbox
    stopBot(botNumber) {
        return new Promise(async (resolve) => {
            const sandboxName = state.sandboxes.get(botNumber) || `bot${botNumber}`;
            
            // Remove process from monitoring
            this.processes.delete(botNumber);
            
            // Terminate all processes in the sandbox
            logger.info(`Stopping bot ${botNumber} by terminating sandbox ${sandboxName}`);
            const terminationResult = await this.terminateSandboxProcesses(sandboxName);
            
            // Update bot status regardless of termination success
            state.botStatuses[botNumber] = BotStatus.STOPPED;
            
            // Remove from active bots
            state.activeBots.delete(botNumber);
            
            // Remove from restarting bots if there
            state.restartingBots.delete(botNumber);
            
            // Update clients
            this.broadcastBotStatus(botNumber);
            
            logger.info(`Stopped bot ${botNumber} by terminating sandbox ${sandboxName} - result: ${terminationResult ? 'success' : 'partial'}`);
            resolve(terminationResult);
        });
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
        
        // Check if any bots are currently restarting - if so, pause the bot start queue
        if (state.restartingBots.size > 0 && this.io) {
            // Notify any listening components that queue is paused due to auto-restart
            this.io.emit('logMessage', `Bot start queue paused - auto-restart in progress for ${state.restartingBots.size} bot(s)`);
        }
        
        for (const [botNumber, processInfo] of this.processes.entries()) {
            // Skip bots that are already in restart process
            if (state.restartingBots.has(botNumber)) {
                continue;
            }
            
            // Skip if bot is in startup/injection phase - don't restart during these phases
            const currentStatus = state.botStatuses[botNumber];
            const isStartupPhase = [
                BotStatus.INITIALIZING,
                BotStatus.SANDBOX_SETUP,
                BotStatus.VAC_BYPASS_LOADING,
                BotStatus.VAC_BYPASS_LOADED,
                BotStatus.TF2_STARTING,
                BotStatus.INJECTING,
                BotStatus.INJECTION_ERROR
            ].includes(currentStatus);
            
            // Skip auto-restart during the startup/injection phase
            if (isStartupPhase) {
                logger.debug(`Skipping auto-restart check for bot ${botNumber} - in startup phase: ${currentStatus}`);
                continue;
            }
            
            // Check if process was just started (within the last 60 seconds)
            const isRecentlyStarted = processInfo.timestamp && 
                (Date.now() - processInfo.timestamp < 60000); // 60 second grace period
                
            // Skip auto-restart for recently started processes
            if (isRecentlyStarted) {
                logger.debug(`Skipping auto-restart check for bot ${botNumber} - recently started (${Math.floor((Date.now() - processInfo.timestamp) / 1000)} seconds ago)`);
                continue;
            }
            
            if (currentStatus === BotStatus.CRASHED) {
                logger.warn(`Bot ${botNumber} has crashed status - triggering auto-restart`);
                this.handleProcessFailure(botNumber, processInfo.program);
                continue;
            }
            
            if (state.pipeStatuses[botNumber] && state.pipeStatuses[botNumber].includes('Disconnected')) {
                if (currentStatus === BotStatus.ACTIVE || currentStatus === BotStatus.CONNECTED || 
                    currentStatus === BotStatus.RUNNING || currentStatus === BotStatus.INJECTED) {
                    
                    logger.warn(`Bot ${botNumber} has disconnected pipe status: ${state.pipeStatuses[botNumber]} - triggering auto-restart`);
                    
                    if (this.io) {
                        this.io.emit('logMessage', `Bot ${botNumber} pipe status disconnected - triggering auto-restart`);
                    }
                    
                    this.handleProcessFailure(botNumber, processInfo.program);
                    continue;
                }
            }
            
            // Check if process is still running
            if (processInfo.process && processInfo.process.exitCode !== null) {
                logger.warn(`Bot ${botNumber} process has exited with code ${processInfo.process.exitCode}`);
                
                // Only handle if the bot was actually running and has CRASHED status
                if (currentStatus === BotStatus.CRASHED) {
                    this.handleProcessFailure(botNumber, processInfo.program);
                } else {
                    logger.info(`Bot ${botNumber} process exited, but not handling as auto-restart since status is ${currentStatus}`);
                }
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
            BotStatus.SANDBOX_SETUP, 
            BotStatus.VAC_BYPASS_LOADING,
            BotStatus.VAC_BYPASS_LOADED,
            BotStatus.TF2_STARTING,
            BotStatus.INJECTING,
            BotStatus.INJECTION_ERROR
        ].includes(currentStatus);
        
        // Skip auto-restart during the startup/injection phase
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
        
        // Stop all processes in the sandbox to ensure clean slate
        const sandboxName = state.sandboxes.get(botNumber) || `bot${botNumber}`;
        this.terminateSandboxProcesses(sandboxName);
        
        // Send status update to clients
        this.broadcastBotStatus(botNumber);
        
        // Emit auto-restart state update
        this.broadcastAutoRestartState();
        
        // Log the restart
        if (this.io) {
            this.io.emit('logMessage', `Auto-restart triggered for bot ${botNumber}`);
        }
        
        // Schedule restart after a delay to avoid rapid restarts
        setTimeout(() => {
            logger.info(`Restarting bot ${botNumber} after crash`);
            
            // Get account info for this bot if needed
            const account = state.botAccounts && state.botAccounts[botNumber];
            
            // Restart the bot (need to call the appropriate start function from elsewhere)
            // This depends on how bots are started initially
            this.restartBot(botNumber, account);
        }, 10000); // Wait 10 seconds before restart
    }
    
    // Restart a bot after crash
    restartBot(botNumber, account) {
        try {
            logger.info(`Performing restart for bot ${botNumber}`);
            
            // Only continue if bot is in crashed state and auto-restart is still enabled
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
            
            // Run the startup sequence
            this.createSandbox(botNumber);
            
            // If account exists, launch with VAC bypass, otherwise just TF2
            if (account && account.username && account.password) {
                this.launchVacBypass(botNumber, account)
                    .then(() => {
                        // Wait a bit for VAC bypass to initialize
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
                        state.botStatuses[botNumber] = BotStatus.VAC_BYPASS_ERROR;
                        this.broadcastBotStatus(botNumber);
                        this.broadcastAutoRestartState();
                        
                        // Notify about restart failure
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
                
                // Notify that restart is complete
                if (this.io) {
                    this.io.emit('logMessage', `Auto-restart complete for bot ${botNumber}`);
                }
            }
        } catch (err) {
            logger.error(`Error during restart for bot ${botNumber}: ${err.message}`);
            
            // Make sure to remove from restarting set even if an error occurs
            state.restartingBots.delete(botNumber);
            this.broadcastAutoRestartState();
            
            // Notify about restart failure
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
        
        // Create botStatuses object with single entry for this bot
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
        
        // Emit in new bulk format
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
}

module.exports = new SandboxManager(); 