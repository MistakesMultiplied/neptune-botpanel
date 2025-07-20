const socket = io();

const state = {
    bots: {},
    queue: [],
    starting: [],
    settings: {},
    selectedBotNumber: null,
    activePage: 'dashboard',
    experimentalLayout: false,
    autoRestartEnabled: false,
    restartingBots: [],
    activeBots: new Set(),
    botsStarting: new Set()
};

const elements = {
    pages: {
        dashboard: document.getElementById('dashboard-page'),
        settings: document.getElementById('settings-page'),
        logs: document.getElementById('logs-page'),
        guides: document.getElementById('guides-page')
    },
    botGrid: document.querySelector('.bot-grid'),
    botCommands: document.getElementById('bot-commands'),
    queueList: document.getElementById('queue-list'),
    currentlyStarting: document.getElementById('currently-starting'),
    queueCount: document.getElementById('queue-count'),
    activeBots: document.getElementById('active-bots'),
    botQuota: document.getElementById('bot-quota'),
    logs: document.getElementById('logs'),
    selectedBotNumber: document.getElementById('selected-bot-number'),
    commandInput: document.getElementById('command-input'),
    globalCommandInput: document.getElementById('global-command-input'),
    settingsForm: {
        maxConcurrentStarts: document.getElementById('max-concurrent-starts'),
        botQuota: document.getElementById('bot-quota-setting'),
        tf2StartDelay: document.getElementById('tf2-start-delay'),
        injectDelay: document.getElementById('inject-delay'),
        sandboxiePath: document.getElementById('sandboxie-path'),
        steamPath: document.getElementById('steam-path'),
        tf2Path: document.getElementById('tf2-path'),
        pipeName: document.getElementById('pipe-name'),
        enableTextmodeDelay: document.getElementById('enable-textmode-delay'),
        textmodeDelay: document.getElementById('textmode-delay'),
        experimentalLayout: document.getElementById('experimental-layout'),
        autoRestartEnabled: document.getElementById('auto-restart-enabled')
    },
    autoRestartToggle: document.getElementById('auto-restart-toggle'),
    restartingBotsList: document.getElementById('restarting-bots-list'),
    layoutModal: document.getElementById('layout-modal'),
    modalAccept: document.getElementById('modal-accept'),
    modalReject: document.getElementById('modal-reject')
};

const botCardTemplate = document.getElementById('bot-card-template');

function init() {
    setupEventListeners();
    fetchSettings();
    initSliders();

    const layoutPreference = localStorage.getItem('experimentalLayout');
    if (layoutPreference === null) {
        showLayoutModal();
    } else {
        setLayoutMode(layoutPreference === 'true');
    }

    setupColorCustomization();
    initializePipeStatus();
}

function initSliders() {
    const sliders = document.querySelectorAll('input[type="range"]');
    
    sliders.forEach(slider => {
        updateSliderFill(slider);
        
        slider.addEventListener('input', () => {
            updateSliderFill(slider);
        });
    });
}

function updateSliderFill(slider) {
    const min = slider.min || 0;
    const max = slider.max || 100;
    const value = slider.value;
    
    const fillPercent = ((value - min) / (max - min)) * 100;
    
    slider.style.background = `linear-gradient(to right, var(--primary-color) 0%, var(--primary-color) ${fillPercent}%, rgba(0, 0, 0, 0.3) ${fillPercent}%, rgba(0, 0, 0, 0.3) 100%)`;
    
    const output = document.querySelector(`output[for="${slider.id}"]`);
    if (output) {
        output.textContent = value;
    }
}

function showLayoutModal() {
    elements.layoutModal.classList.add('active');
}

function setLayoutMode(isExperimental) {
    state.experimentalLayout = isExperimental;
    
    if (elements.settingsForm.experimentalLayout) {
        elements.settingsForm.experimentalLayout.checked = isExperimental;
    }
    
    if (isExperimental) {
        document.body.classList.add('experimental');
    } else {
        document.body.classList.remove('experimental');
    }
    
    localStorage.setItem('experimentalLayout', isExperimental);
    
    setTimeout(() => {
        const sliders = document.querySelectorAll('input[type="range"]');
        sliders.forEach(slider => updateSliderFill(slider));
    }, 100);
}

function setupEventListeners() {
    document.querySelectorAll('nav li').forEach(item => {
        item.addEventListener('click', () => {
            navigateTo(item.dataset.page);
        });
    });

    document.getElementById('start-all-bots').addEventListener('click', startAllBots);

    document.getElementById('stop-all-bots').addEventListener('click', stopAllBots);
    
    document.getElementById('clear-logs').addEventListener('click', clearLogs);
    
    document.getElementById('save-settings').addEventListener('click', saveSettings);
    
    const textmodeSlider = document.getElementById('textmode-delay');
    const textmodeOutput = document.getElementById('textmode-delay-value');
    
    if (textmodeSlider && textmodeOutput) {
        textmodeSlider.addEventListener('input', function() {
            textmodeOutput.textContent = this.value;
        });
    }
    
    document.querySelector('.close-commands').addEventListener('click', () => {
        elements.botCommands.classList.remove('active');
    });
    
    document.getElementById('send-command').addEventListener('click', sendCommand);
    document.getElementById('command-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendCommand();
        }
    });
    
    document.getElementById('send-all-command').addEventListener('click', sendCommandToAllBots);
    document.getElementById('global-command-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendCommandToAllBots();
        }
    });
    
    document.getElementById('auto-restart-toggle').addEventListener('change', function() {
        toggleAutoRestart(this.checked);
    });
    
    document.getElementById('modal-accept').addEventListener('click', () => {
        setLayoutMode(true);
        elements.layoutModal.classList.remove('active');
    });
    
    document.getElementById('modal-reject').addEventListener('click', () => {
        setLayoutMode(false);
        elements.layoutModal.classList.remove('active');
    });
    
    const contributeClose = document.getElementById('contribute-close');
    const modalClose = document.querySelector('#contribute-modal .modal-close');
    
    if (contributeClose) {
        contributeClose.addEventListener('click', () => {
            document.getElementById('contribute-modal').classList.remove('active');
        });
    }
    
    if (modalClose) {
        modalClose.addEventListener('click', () => {
            document.getElementById('contribute-modal').classList.remove('active');
        });
    }
    
    document.querySelectorAll('.modal-overlay').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
            }
        });
    });
    
    document.querySelector('.bot-grid').addEventListener('click', (e) => {
        const botCard = e.target.closest('.bot-card');
        if (!botCard) return;
        
        const botNumber = parseInt(botCard.dataset.botNumber);
        
        if (e.target.classList.contains('btn-start')) {
            startBot(botNumber);
        } else if (e.target.classList.contains('btn-stop')) {
            stopBot(botNumber);
        } else if (e.target.classList.contains('btn-restart')) {
            restartBot(botNumber);
        } else if (e.target.classList.contains('btn-command')) {
            openCommandPanel(botNumber);
        }
    });
    
    document.querySelectorAll('.preset-command').forEach(button => {
        button.addEventListener('click', () => {
            const command = button.dataset.command;
            document.getElementById('command-input').value = command;
            sendCommand();
        });
    });
    
    socket.on('connect', () => {
        addLog('Connected to server');
    });
    
    socket.on('statusUpdate', updateBotStatus);
    socket.on('botUpdate', updateBotInfo);
    socket.on('queueUpdate', updateQueue);
    socket.on('quotaUpdate', updateQuota);
    socket.on('logMessage', addLog);
    socket.on('autoRestartState', updateAutoRestartState);
    socket.on('settingsUpdate', (settings) => {
        state.settings = settings;
        updateSettingsForm(settings);
    });
}

function navigateTo(page) {
    Object.values(elements.pages).forEach(pageEl => {
        pageEl.classList.add('hidden');
    });
    
    elements.pages[page].classList.remove('hidden');
    
    document.querySelectorAll('nav li').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.page === page) {
            item.classList.add('active');
        }
    });
    
    state.activePage = page;
}

function createInitialBotCards() {
    elements.botGrid.innerHTML = '';
    state.bots = {};
    
    const botQuota = state.settings.botQuota || 10;
    
    for (let i = 1; i <= botQuota; i++) {
        createBotCard(i);
    }
}

function createBotCard(botNumber) {
    const clone = botCardTemplate.content.cloneNode(true);
    const card = clone.querySelector('.bot-card');
    
    card.id = `bot-${botNumber}`;
    card.dataset.botNumber = botNumber;
    card.querySelector('.bot-number').textContent = botNumber;
    
    card.querySelector('.btn-start').addEventListener('click', () => {
        startBot(botNumber);
    });
    
    card.querySelector('.btn-stop').addEventListener('click', () => {
        stopBot(botNumber);
    });
    
    card.querySelector('.btn-restart').addEventListener('click', () => {
        restartBot(botNumber);
    });
    
    card.querySelector('.btn-command').addEventListener('click', () => {
        openCommandPanel(botNumber);
    });
    
    elements.botGrid.appendChild(card);
    
    state.bots[botNumber] = {
        status: 'Not Started',
        pipeStatus: 'Disconnected',
        health: '-',
        playerClass: '-',
        map: '-',
        lastHeartbeat: null
    };
    
    const pipeStatusElement = card.querySelector('.pipe-status');
    if (pipeStatusElement && pipeStatusElement.textContent === 'Disconnected') {
        pipeStatusElement.classList.add('pipe-status-disconnected');
    }
}

function updateBotStatus(data) {
    if (!state.activeBots) state.activeBots = new Set();
    if (!state.botsStarting) state.botsStarting = new Set();

    if (data.botNumber !== undefined && !data.botStatuses) {
        const botNumber = data.botNumber;
        data = {
            autoRestartEnabled: state.autoRestartEnabled,
            botStatuses: {
                [botNumber]: {
                    status: data.status,
                    pipeStatus: data.pipeStatus,
                    lastHeartbeat: data.lastHeartbeat,
                    active: state.activeBots && state.activeBots.has ? state.activeBots.has(botNumber) : false,
                    starting: state.botsStarting && state.botsStarting.has ? state.botsStarting.has(botNumber) : false,
                    isRestarting: data.isRestarting
                }
            }
        };
    }

    if (data.autoRestartEnabled !== undefined) {
        state.autoRestartEnabled = data.autoRestartEnabled;
        
        if (elements.autoRestartToggle) {
            elements.autoRestartToggle.checked = data.autoRestartEnabled;
        }
    }
    
    if (!data.botStatuses) {
        console.warn('Received status update without botStatuses property', data);
        return;
    }
    
    const domUpdates = [];
    
    for (const [botNumber, status] of Object.entries(data.botStatuses)) {
        const botNumberInt = parseInt(botNumber);
        
        const cardId = `bot-${botNumberInt}`;
        let needsCardCreation = false;
        if (!document.getElementById(cardId)) {
            needsCardCreation = true;
        }
        
        if (status.active) {
            if (!state.activeBots) state.activeBots = new Set();
            state.activeBots.add(botNumberInt);
        } else {
            if (state.activeBots && state.activeBots.has && state.activeBots.has(botNumberInt)) {
                state.activeBots.delete(botNumberInt);
            }
        }
        
        if (status.starting) {
            if (!state.botsStarting) state.botsStarting = new Set();
            state.botsStarting.add(botNumberInt);
        } else {
            if (state.botsStarting && state.botsStarting.has && state.botsStarting.has(botNumberInt)) {
                state.botsStarting.delete(botNumberInt);
            }
        }
        
        const statusText = status.status || 'Unknown';
        if (statusText !== 'Not Started' && statusText !== 'Stopped' && statusText !== 'Unknown') {
            if (!status.active) {
                state.activeBots.add(botNumberInt);
            }
        }
        
        state.bots[botNumberInt] = status;
        
        domUpdates.push(() => {
            if (needsCardCreation) {
                createBotCard(botNumberInt);
            }
            
            const card = document.getElementById(cardId);
            if (card) {
                const statusElement = card.querySelector('.bot-status');
                statusElement.textContent = statusText;
                
                statusElement.classList.remove('status-active', 'status-error', 'status-loading', 'status-stopped', 'status-restarting');
                
                if (state.restartingBots.includes(botNumberInt)) {
                    statusElement.classList.add('status-restarting');
                } else if (statusText.includes('Error') || statusText === 'Crashed') {
                    statusElement.classList.add('status-error');
                } else if (statusText === 'Active' || statusText === 'Running' || statusText === 'Connected to Server') {
                    statusElement.classList.add('status-active');
                } else if (statusText === 'Not Started' || statusText === 'Stopped') {
                    statusElement.classList.add('status-stopped');
                } else {
                    statusElement.classList.add('status-loading');
                }
                
                const pipeStatusElement = card.querySelector('.pipe-status');
                if (pipeStatusElement && status.pipeStatus) {
                    pipeStatusElement.textContent = status.pipeStatus;
                    
                    pipeStatusElement.classList.remove('pipe-status-connected', 'pipe-status-disconnected');
                    if (status.pipeStatus === 'Connected') {
                        pipeStatusElement.classList.add('pipe-status-connected');
                    } else if (status.pipeStatus === 'Disconnected') {
                        pipeStatusElement.classList.add('pipe-status-disconnected');
                    }
                }
                
                if (status.lastHeartbeat) {
                    const lastUpdateElement = card.querySelector('.last-update');
                    if (lastUpdateElement) {
                        const lastUpdate = new Date(status.lastHeartbeat);
                        lastUpdateElement.textContent = lastUpdate.toLocaleTimeString();
                    }
                }
            }
        });
    }
    
    if (domUpdates.length > 0) {
        window.requestAnimationFrame(() => {
            for (const update of domUpdates) {
                update();
            }
        });
    }
}

function updateBotInfo(data) {
    const { botNumber, health, playerClass, map, lastHeartbeat } = data;
    
    if (!state.bots[botNumber]) {
        createBotCard(botNumber);
    }
    
    if (health !== undefined) state.bots[botNumber].health = health;
    if (playerClass !== undefined) state.bots[botNumber].playerClass = playerClass;
    if (map !== undefined) state.bots[botNumber].map = map;
    if (lastHeartbeat) state.bots[botNumber].lastHeartbeat = lastHeartbeat;
    
    const card = document.querySelector(`.bot-card[data-bot-number="${botNumber}"]`);
    if (card) {
        if (health !== undefined) card.querySelector('.bot-health').textContent = health;
        if (playerClass !== undefined) card.querySelector('.bot-class').textContent = playerClass;
        if (map !== undefined) card.querySelector('.bot-map').textContent = map;
        
        if (lastHeartbeat) {
            const lastUpdate = new Date(lastHeartbeat);
            card.querySelector('.last-update').textContent = lastUpdate.toLocaleTimeString();
        }
    }
}

function updateQueue(data) {
    const { currentlyStarting, inQueue } = data;
    
    if (!state.botsStarting) state.botsStarting = new Set();
    
    state.starting = currentlyStarting;
    state.queue = inQueue;
    
    state.botsStarting.clear();
    currentlyStarting.forEach(botNumber => {
        state.botsStarting.add(parseInt(botNumber));
    });
    
    elements.currentlyStarting.textContent = currentlyStarting.length;
    elements.queueCount.textContent = inQueue.length;
    
    elements.queueList.innerHTML = '';
    inQueue.forEach(botNumber => {
        const item = document.createElement('div');
        item.className = 'queue-item';
        item.textContent = `Bot ${botNumber}`;
        elements.queueList.appendChild(item);
    });
}

function updateQuota(data) {
    const { current, total } = data;
    
    elements.activeBots.textContent = current;
    elements.botQuota.textContent = total;
    
    if (state.settings && state.settings.botQuota !== total) {
        state.settings.botQuota = total;
        createInitialBotCards();
    }
}

function addLog(message) {
    const now = new Date();
    const timeStr = now.toLocaleTimeString();
    
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = timeStr;
    
    const messageSpan = document.createElement('span');
    messageSpan.textContent = message;
    
    logEntry.appendChild(timeSpan);
    logEntry.appendChild(messageSpan);
    
    elements.logs.appendChild(logEntry);
    elements.logs.scrollTop = elements.logs.scrollHeight;
}

function clearLogs() {
    elements.logs.innerHTML = '';
    addLog('Logs cleared');
}

function startBot(botNumber) {
    socket.emit('startBot', botNumber);
    addLog(`Starting Bot ${botNumber}`);
}

function stopBot(botNumber) {
    socket.emit('stopBot', botNumber);
    addLog(`Stopping Bot ${botNumber}`);
}

function restartBot(botNumber) {
    socket.emit('restartBot', botNumber);
    addLog(`Restarting Bot ${botNumber}`);
}

function startAllBots() {
    const botQuota = state.settings.botQuota || 10;
    
    for (let i = 1; i <= botQuota; i++) {
        if ((!state.activeBots || !state.activeBots.has(i)) && 
            (!state.botsStarting || !state.botsStarting.has(i))) {
            startBot(i);
        }
    }
}

function stopAllBots() {
    socket.emit('stopAllBots');
    addLog('Stopping all bots');
}

function openCommandPanel(botNumber) {
    state.selectedBotNumber = botNumber;
    elements.selectedBotNumber.textContent = botNumber;
    elements.botCommands.classList.add('active');
    elements.commandInput.focus();
}

function sendCommand() {
    const command = elements.commandInput.value.trim();
    if (command && state.selectedBotNumber !== null) {
        socket.emit('sendCommand', {
            botNumber: state.selectedBotNumber,
            command: command
        });
        addLog(`Sent command to Bot ${state.selectedBotNumber}: ${command}`);
        elements.commandInput.value = '';
    }
}

function sendCommandToAllBots() {
    const command = elements.globalCommandInput.value.trim();
    if (command) {
        socket.emit('sendCommandToAllBots', {
            command: command
        });
        addLog(`Sent command to all bots: ${command}`);
        elements.globalCommandInput.value = '';
    }
}

function fetchSettings() {
    fetch('/api/settings')
        .then(response => response.json())
        .then(settings => {
            state.settings = settings;
            updateSettingsForm(settings);
            
            fetchStatus();
        })
        .catch(error => {
            console.error('Error fetching settings:', error);
        });
}

function fetchStatus() {
    fetch('/api/status')
        .then(response => response.json())
        .then(status => {
            updateBotStatus(status);
            
            updateQuota({
                active: status.botsActive,
                total: status.quotaTotal
            });
            
            createInitialBotCards();
            
            fetch('/api/auto-restart/status')
                .then(response => response.json())
                .then(data => {
                    updateAutoRestartState(data);
                })
                .catch(error => {
                    console.error('Error fetching auto-restart status:', error);
                });
        })
        .catch(error => {
            console.error('Error fetching status:', error);
        });
}

function updateSettingsForm(settings) {
    elements.settingsForm.maxConcurrentStarts.value = settings.maxConcurrentStarts || 2;
    elements.settingsForm.botQuota.value = settings.botQuota || 10;
    elements.settingsForm.tf2StartDelay.value = settings.tf2StartDelay || 10000;
    elements.settingsForm.injectDelay.value = settings.injectDelay || 5;
    elements.settingsForm.sandboxiePath.value = settings.sandboxiePath || 'C:\\Program Files\\Sandboxie-Plus\\Start.exe';
    elements.settingsForm.steamPath.value = settings.steamPath || 'C:\\Program Files (x86)\\Steam\\steam.exe';
    elements.settingsForm.tf2Path.value = settings.tf2Path || 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Team Fortress 2\\tf_win64.exe';
    elements.settingsForm.pipeName.value = settings.pipeName || '\\\\.\\pipe\\AwootismBotPipe';
    
    if (elements.settingsForm.enableTextmodeDelay) {
        elements.settingsForm.enableTextmodeDelay.checked = settings.enableTextmodeDelay || false;
    }
    
    if (elements.settingsForm.textmodeDelay) {
        const delay = settings.textmodeDelay || 1.5;
        elements.settingsForm.textmodeDelay.value = delay;
        
        const textmodeOutput = document.getElementById('textmode-delay-value');
        if (textmodeOutput) {
            textmodeOutput.textContent = delay;
        }
    }
}

function saveSettings() {
    const settings = {
        maxConcurrentStarts: parseInt(elements.settingsForm.maxConcurrentStarts.value),
        botQuota: parseInt(elements.settingsForm.botQuota.value),
        tf2StartDelay: parseInt(elements.settingsForm.tf2StartDelay.value),
        injectDelay: parseInt(elements.settingsForm.injectDelay.value),
        enableTextmodeDelay: elements.settingsForm.enableTextmodeDelay.checked,
        textmodeDelay: parseFloat(elements.settingsForm.textmodeDelay.value),
        sandboxiePath: elements.settingsForm.sandboxiePath.value,
        steamPath: elements.settingsForm.steamPath.value,
        tf2Path: elements.settingsForm.tf2Path.value,
        pipeName: elements.settingsForm.pipeName.value
    };
    
    const quotaChanged = !state.settings || state.settings.botQuota !== settings.botQuota;
    
    fetch('/api/settings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(settings)
    })
    .then(response => response.json())
    .then(result => {
        if (result.success) {
            addLog('Settings saved successfully');
            state.settings = settings;
            
            if (quotaChanged) {
                addLog(`Bot quota updated to ${settings.botQuota}`);
                createInitialBotCards();
            }
        } else {
            addLog('Error saving settings');
        }
    })
    .catch(error => {
        console.error('Error saving settings:', error);
        addLog('Error saving settings');
    });
}

function updateAutoRestartState(data) {
    state.autoRestartEnabled = data.enabled;
    state.restartingBots = data.restartingBots || [];
    
    if (elements.autoRestartToggle) {
        elements.autoRestartToggle.checked = data.enabled;
    }
    
    updateRestartingBotsList();
    
    if (data.enabled) {
        addLog(`Auto-restart enabled`);
    } else {
        addLog(`Auto-restart disabled`);
    }
}

function toggleAutoRestart(enabled) {
    socket.emit('toggleAutoRestart', enabled);
}

function updateRestartingBotsList() {
    if (!elements.restartingBotsList) return;
    
    elements.restartingBotsList.innerHTML = '';
    
    if (state.restartingBots.length === 0) {
        elements.restartingBotsList.innerHTML = '<span class="empty-list">No bots are currently restarting</span>';
        return;
    }
    
    state.restartingBots.forEach(botNumber => {
        const item = document.createElement('div');
        item.classList.add('restarting-bot-item');
        item.innerHTML = `
            <span>Bot ${botNumber}</span>
            <div class="spinner"></div>
        `;
        elements.restartingBotsList.appendChild(item);
    });
}

function setupColorCustomization() {
    const themes = {
        default: {
            'primary-color': '#3a86ff',
            'primary-hover': '#2970e3',
            'secondary-color': '#1d2636',
            'danger-color': '#ef476f',
            'warning-color': '#ffd166',
            'info-color': '#118ab2',
            'success-color': '#06d6a0',
            'dark-bg': '#121826',
            'card-bg': '#1e2a3d',
            'sidebar-bg': '#1a2235',
            'text-color': '#ffffff',
            'text-muted': '#a2b4cf',
            'border-color': '#2e3c54',
        },
        'dark-blue': {
            'primary-color': '#4361ee',
            'primary-hover': '#3a56d4',
            'secondary-color': '#1e1e30',
            'danger-color': '#ef233c',
            'warning-color': '#f9c74f',
            'info-color': '#4cc9f0',
            'success-color': '#52b788',
            'dark-bg': '#0f111a',
            'card-bg': '#16213e',
            'sidebar-bg': '#131729',
            'text-color': '#ffffff',
            'text-muted': '#8d99ae',
            'border-color': '#2b2d42',
        },
        'dark-red': {
            'primary-color': '#e63946',
            'primary-hover': '#d62b39',
            'secondary-color': '#1d1a1a',
            'danger-color': '#ff5a5f',
            'warning-color': '#ffb703',
            'info-color': '#457b9d',
            'success-color': '#2a9d8f',
            'dark-bg': '#1a1818',
            'card-bg': '#251f20',
            'sidebar-bg': '#22191a',
            'text-color': '#ffffff',
            'text-muted': '#b1a7a6',
            'border-color': '#3d3133',
        },
        'dark-green': {
            'primary-color': '#2a9d8f',
            'primary-hover': '#238b80',
            'secondary-color': '#1a2721',
            'danger-color': '#ef476f',
            'warning-color': '#fb8500',
            'info-color': '#2c699a',
            'success-color': '#52b788',
            'dark-bg': '#102017',
            'card-bg': '#1a2e21',
            'sidebar-bg': '#172b1f',
            'text-color': '#ffffff',
            'text-muted': '#8fa9a0',
            'border-color': '#2c4c3b',
        },
        'high-contrast': {
            'primary-color': '#ffffff',
            'primary-hover': '#e6e6e6',
            'secondary-color': '#121212',
            'danger-color': '#ff0000',
            'warning-color': '#ffcc00',
            'info-color': '#00ccff',
            'success-color': '#00ff00',
            'dark-bg': '#000000',
            'card-bg': '#0f0f0f',
            'sidebar-bg': '#0a0a0a',
            'text-color': '#ffffff',
            'text-muted': '#aaaaaa',
            'border-color': '#333333',
        }
    };
    
    const colorInputs = document.querySelectorAll('.color-input-container input[type="color"]');
    const colorValues = document.querySelectorAll('.color-input-container .color-value');
    const colorPresets = document.querySelectorAll('.color-preset');
    
    colorInputs.forEach((input, index) => {
        input.addEventListener('input', () => {
            colorValues[index].textContent = input.value;
            
            setActivePreset('theme-custom');
        });
    });
    
    colorPresets.forEach(preset => {
        preset.addEventListener('click', () => {
            const themeId = preset.id.replace('theme-', '');
            setActivePreset(preset.id);
            
            if (themeId !== 'custom' && themes[themeId]) {
                applyColorTheme(themes[themeId]);
            }
        });
    });
    
    const saveColorsBtn = document.getElementById('save-colors');
    const resetColorsBtn = document.getElementById('reset-colors');
    
    saveColorsBtn.addEventListener('click', () => {
        const customColors = {};
        
        colorInputs.forEach(input => {
            const varName = input.id.replace(/-/g, '-');
            customColors[varName] = input.value;
        });
        
        saveCustomTheme(customColors);
        applyColorTheme(customColors);
        
        showNotification('Colors saved successfully!');
    });
    
    resetColorsBtn.addEventListener('click', () => {
        setActivePreset('theme-default');
        applyColorTheme(themes.default);
        loadColorsToInputs(themes.default);
        
        showNotification('Colors reset to default');
    });
    
    loadSavedTheme();
    
    function setActivePreset(presetId) {
        colorPresets.forEach(p => p.classList.remove('active'));
        document.getElementById(presetId).classList.add('active');
    }
    
    function applyColorTheme(theme) {
        const root = document.documentElement;
        
        for (const [property, value] of Object.entries(theme)) {
            root.style.setProperty(`--${property}`, value);
        }
    }
    
    function loadColorsToInputs(theme) {
        colorInputs.forEach(input => {
            const varName = input.id.replace(/-/g, '-');
            if (theme[varName]) {
                input.value = theme[varName];
                
                const valueSpan = input.nextElementSibling;
                if (valueSpan && valueSpan.classList.contains('color-value')) {
                    valueSpan.textContent = theme[varName];
                }
            }
        });
    }
    
    function saveCustomTheme(theme) {
        localStorage.setItem('neptune-theme', JSON.stringify({
            name: 'custom',
            colors: theme
        }));
    }
    
    function loadSavedTheme() {
        try {
            const savedTheme = localStorage.getItem('neptune-theme');
            if (savedTheme) {
                const themeData = JSON.parse(savedTheme);
                
                if (themeData.name === 'custom') {
                    setActivePreset('theme-custom');
                    applyColorTheme(themeData.colors);
                    loadColorsToInputs(themeData.colors);
                } else if (themes[themeData.name]) {
                    setActivePreset(`theme-${themeData.name}`);
                    applyColorTheme(themes[themeData.name]);
                    loadColorsToInputs(themes[themeData.name]);
                }
            }
        } catch (error) {
            console.error('Error loading saved theme:', error);
        }
    }
    
    function showNotification(message) {
        const notification = document.createElement('div');
        notification.className = 'notification';
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        setTimeout(() => notification.classList.add('visible'), 10);
        
        setTimeout(() => {
            notification.classList.remove('visible');
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
}

function initializePipeStatus() {
    setTimeout(() => {
        document.querySelectorAll('.pipe-status').forEach(element => {
            if (element.textContent === 'Connected') {
                element.classList.add('pipe-status-connected');
            } else if (element.textContent === 'Disconnected') {
                element.classList.add('pipe-status-disconnected');
            }
        });
    }, 1000);
}

function showContributeModal() {
    const contributeModal = document.getElementById('contribute-modal');
    if (contributeModal) {
        contributeModal.classList.add('active');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    init();
    
    console.log('Showing contribute modal for testing');
    setTimeout(showContributeModal, 1500);
}); 
