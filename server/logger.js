const fs = require('fs');
const path = require('path');
const util = require('util');

class Logger {
    constructor() {
        this.logDir = path.join(__dirname, '../logs');
        this.logFile = path.join(this.logDir, 'server.log');
        this.debugEnabled = process.env.DEBUG === 'true';
        
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }
    
    timestamp() {
        const now = new Date();
        return now.toISOString();
    }
    
    formatMessage(level, message) {
        return `[${this.timestamp()}] [${level}] ${message}`;
    }
    
    log(level, message) {
        const formattedMessage = this.formatMessage(level, message);
        
        console.log(formattedMessage);
        
        try {
            fs.appendFileSync(this.logFile, formattedMessage + '\n');
        } catch (err) {
            console.error(`Failed to write to log file: ${err.message}`);
        }
        
        return formattedMessage;
    }
    
    debug(message) {
        if (this.debugEnabled) {
            return this.log('DEBUG', message);
        }
    }
    
    info(message) {
        return this.log('INFO', message);
    }
    
    warn(message) {
        return this.log('WARN', message);
    }
    
    error(message) {
        return this.log('ERROR', message);
    }
    
    logObject(level, message, obj) {
        const objString = util.inspect(obj, { depth: null, colors: false });
        return this.log(level, `${message}\n${objString}`);
    }
}

module.exports = new Logger();