const { readFileSync, writeFileSync } = require('fs');
const path = require('path');

// Load configuration from file
function loadConfig() {
    try {
        const configPath = path.join(__dirname, '../config.json');
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        return config;
    } catch (error) {
        console.error('Error loading config, using defaults:', error.message);
        return {
            maxConcurrentStarts: 2,
            botQuota: 10,
            tf2StartDelay: 5000,
            injectDelay: 5,
            enableTextmodeDelay: false,
            textmodeDelay: 1.5,
            autoRestartEnabled: false,
            sandboxiePath: 'C:\\Program Files\\Sandboxie-Plus\\Start.exe',
            steamPath: 'C:\\Program Files (x86)\\Steam\\steam.exe',
            tf2Path: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Team Fortress 2\\tf_win64.exe',
            pipeName: '\\\\.\\pipe\\AwootismBotPipe',
            accountsFile: path.join(__dirname, '../files/accounts.txt')
        };
    }
}

// Bot status enum with clearly defined states
const BotStatus = {
    // System statuses
    NOT_STARTED: "Not Started",
    STOPPED: "Stopped",
    CRASHED: "Crashed",
    
    // Initialization statuses
    INITIALIZING: "Initializing",
    SANDBOX_SETUP: "Setting up Sandbox",
    SANDBOX_ERROR: "Sandbox Error",
    
    // VAC Bypass statuses
    VAC_BYPASS_LOADING: "Loading VAC Bypass",
    VAC_BYPASS_LOADED: "VAC Bypass Loaded",
    VAC_BYPASS_ERROR: "VAC Bypass Error",
    
    // Steam and TF2 statuses
    STEAM_STARTING: "Starting Steam",
    STEAM_ERROR: "Steam Error",
    TF2_STARTING: "Starting TF2",
    TF2_ERROR: "TF2 Error",
    TF2_RESTARTING: "TF2 Restarting",
    
    // Cheat injection statuses
    INJECTING: "Injecting",
    INJECTION_ERROR: "Injection Error",
    INJECTED: "Injected",
    
    // Connection statuses
    CONNECTING: "Connecting to Server",
    CONNECTED: "Connected to Server",
    DISCONNECTED: "Disconnected from Server",
    
    // Active statuses
    ACTIVE: "Active",
    RUNNING: "Running"
};

// Clean state management with organized sections
class PanelState {
    constructor() {
        this.config = loadConfig();
        
        // Bot management
        this.activeBots = new Set();
        this.botStatuses = {};
        this.botsStarting = new Set();
        this.botQueue = [];
        
        // Pipe connections
        this.pipeConnections = new Map();
        this.pipeStatuses = {};
        this.disconnectTimers = new Map();
        this.lastHeartbeats = {};
        
        // Sandboxie state
        this.sandboxes = new Map();
        
        // Auto-restart settings
        this.autoRestartEnabled = this.config.autoRestartEnabled || false;
        this.restartingBots = new Set();
    }
    
    // Getters and helper functions
    getTotalActiveBots() {
        return this.activeBots.size + this.botsStarting.size;
    }
    
    isQuotaExceeded() {
        return this.getTotalActiveBots() >= this.config.botQuota;
    }
    
    // Save config changes to disk
    saveConfig() {
        try {
            const configPath = path.join(__dirname, '../config.json');
            writeFileSync(configPath, JSON.stringify(this.config, null, 2));
        } catch (error) {
            console.error('Error saving config:', error.message);
        }
    }
}

// Create and export a singleton instance
const state = new PanelState();
module.exports = { state, BotStatus }; 