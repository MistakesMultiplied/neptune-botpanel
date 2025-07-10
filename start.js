#!/usr/bin/env node

/**
 * neptune Panel Startup Script
 * 
 * This script checks for required files, validates paths,
 * and starts the web panel server.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const chalk = require('chalk');

// Banner
console.log(chalk.green(`
███╗   ██╗███████╗██████╗ ████████╗██╗   ██╗███╗   ██╗███████╗
████╗  ██║██╔════╝██╔══██╗╚══██╔══╝██║   ██║████╗  ██║██╔════╝
██╔██╗ ██║█████╗  ██████╔╝   ██║   ██║   ██║██╔██╗ ██║█████╗  
██║╚██╗██║██╔══╝  ██╔═══╝    ██║   ██║   ██║██║╚██╗██║██╔══╝  
██║ ╚████║███████╗██║        ██║   ╚██████╔╝██║ ╚████║███████╗
╚═╝  ╚═══╝╚══════╝╚═╝        ╚═╝    ╚═════╝ ╚═╝  ╚═══╝╚══════╝
`));

// Configuration
const requiredFiles = [
    { name: 'attach.exe', path: 'files/attach.exe' },
    { name: 'Amalgamx64ReleaseTextmode.dll', path: 'files/Amalgamx64ReleaseTextmode.dll' },
    { name: 'VAC-Bypass-Loader.exe', path: 'files/VAC-Bypass-Loader.exe' },
    { name: 'VAC-Bypass.dll', path: 'files/VAC-Bypass.dll' },
    { name: 'textmode-preload.dll', path: 'files/textmode-preload.dll' },
    { name: 'accounts.txt', path: 'files/accounts.txt', canCreate: true }
];

// Check if files directory exists
const filesDir = path.join(__dirname, 'files');
if (!fs.existsSync(filesDir)) {
    console.log(chalk.yellow('Creating files directory...'));
    fs.mkdirSync(filesDir, { recursive: true });
}

// Check for required files
console.log(chalk.cyan('Checking for required files...'));
const missingFiles = [];

requiredFiles.forEach(file => {
    const filePath = path.join(__dirname, file.path);
    if (!fs.existsSync(filePath)) {
        // If the file can be created with a template, do it
        if (file.canCreate) {
            if (file.name === 'accounts.txt') {
                console.log(chalk.yellow(`Creating template ${file.name}...`));
                // Create a template accounts.txt file
                const template = `# Steam accounts for TF2 bots
# Format: login:password
# One account per line
# Example:
# account1:password1
# account2:password2

# Add your accounts below this line:
`;
                fs.writeFileSync(filePath, template);
                console.log(chalk.green(`✓ Created ${file.name} template`));
            }
        } else {
            missingFiles.push(file);
            console.log(chalk.red(`✘ Missing ${file.name}`));
        }
    } else {
        console.log(chalk.green(`✓ Found ${file.name}`));
    }
});

if (missingFiles.length > 0) {
    console.log(chalk.yellow('\nWarning: Some required files are missing!'));
    console.log(chalk.yellow('Please place the following files in the files directory:'));
    missingFiles.forEach(file => {
        console.log(chalk.yellow(`- ${file.name}`));
    });
    console.log(chalk.yellow('\nThe panel will still start, but some functions may not work correctly.'));
}

// Check if config.json exists, if not create it
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
    console.log(chalk.yellow('Creating default config.json...'));
    const defaultConfig = {
        maxConcurrentStarts: 2,
        botQuota: 10,
        tf2StartDelay: 10000,
        injectDelay: 5000,
        botStartInterval: 4000,
        sandboxiePath: 'C:\\Program Files\\Sandboxie-Plus\\Start.exe',
        steamPath: 'C:\\Program Files (x86)\\Steam\\steam.exe',
        tf2Path: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Team Fortress 2\\tf_win64.exe',
        pipeName: '\\\\.\\pipe\\AwootismBotPipe'
    };
    
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    console.log(chalk.green('Created default config.json'));
}

// Start the server
console.log(chalk.cyan('\nStarting neptune Panel Server...'));

const server = spawn('node', ['server/server.js'], {
    stdio: 'inherit',
    cwd: __dirname
});

server.on('error', (err) => {
    console.error(chalk.red('Failed to start server:'), err);
    process.exit(1);
});

console.log(chalk.green('Server started! Opening http://localhost:3000 in your browser.'));

// Try to open browser
try {
    const open = require('open');
    open('http://localhost:3000').catch(() => {
        console.log(chalk.yellow('Could not automatically open browser. Please navigate to http://localhost:3000'));
    });
} catch (err) {
    console.log(chalk.yellow('Please navigate to http://localhost:3000 in your browser to access the panel.'));
}

// Handle process termination
process.on('SIGINT', () => {
    console.log(chalk.yellow('\nShutting down server...'));
    server.kill('SIGINT');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log(chalk.yellow('\nShutting down server...'));
    server.kill('SIGTERM');
    process.exit(0);
}); 