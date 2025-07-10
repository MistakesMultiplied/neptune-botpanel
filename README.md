# Neptune Panel for TF2

Neptune Panel is a web-based control panel for managing TF2 bots with neptune. This panel allows you to easily manage multiple bot instances through a user-friendly interface.

## Features

- Web-based control panel accessible through your browser
- Manage multiple bot instances simultaneously 
- Automated sandbox creation and configuration
- Steam account management with auto-login
- Advanced bot control options
- VAC bypass integration

## Prerequisites

- Windows 10 or 11
- [Node.js](https://nodejs.org/) (v14 or newer)
- [Sandboxie Plus](https://sandboxie-plus.com/) (latest version)
- Steam
- Team Fortress 2

## Installation

1. Clone or download this repository to your local machine
2. Navigate to the project folder
3. Run `start.bat` to start the panel

The script will automatically install required dependencies and start the panel server.

## Required Files

Place the following files in the `/files` directory:

1. **attach.exe** - The injector executable
2. **Amalgamx64ReleaseTextmode.dll** - The neptune DLL
3. **VAC-Bypass-Loader.exe** - The VAC bypass loader
4. **VAC-Bypass.dll** - The VAC bypass DLL
5. **textmode-preload.dll** - The textmode preload DLL
6. **accounts.txt** - Steam account credentials

### accounts.txt Format

```
username1:password1
username2:password2
```

Lines starting with `#` are considered comments and will be ignored.

## Sandboxie Setup

The panel requires Sandboxie Plus to be installed and properly configured:

1. Install [Sandboxie Plus](https://sandboxie-plus.com/) (latest version)
2. Ensure the default installation path is used: `C:\Program Files\Sandboxie-Plus\`
3. The panel will automatically create sandboxes named `bot1`, `bot2`, etc.

If your Sandboxie is installed in a different location, modify the `sandboxiePath` in `config.json`.

### Sandbox Configuration

The panel automatically configures each sandbox with the following settings:

- Network access enabled
- Drop admin rights enabled
- OpenGL/DirectX hardware acceleration enabled
- Shared access to Steam folders:
  - Program files
  - Steam libraries
  - User data
  - Workshop data

## Configuration

You can modify the panel settings by editing `config.json`:

```json
{
  "maxConcurrentStarts": 2,     // Maximum bots to start simultaneously
  "botQuota": 20,               // Maximum number of bots
  "tf2StartDelay": 10000,       // Delay before starting TF2 (ms)
  "injectDelay": 50,            // Delay before injecting (ms)
  "sandboxiePath": "C:\\Program Files\\Sandboxie-Plus\\Start.exe",
  "steamPath": "C:\\Program Files (x86)\\Steam\\steam.exe",
  "tf2Path": "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Team Fortress 2\\tf_win64.exe",
  "pipeName": "\\\\.\\pipe\\AwootismBotPipe"
}
```

## Usage

1. Start the panel using `start.bat`
2. The web interface will automatically open at http://localhost:3000
3. Use the web interface to manage your bots:
   - Start/stop bots
   - Monitor status
   - Control bot behavior

## Troubleshooting

### Missing Files
If the panel reports missing files, ensure all required files are placed in the `/files` directory.

### Sandboxie Issues
- Verify Sandboxie Plus is properly installed
- Check Sandboxie logs for any errors
- Ensure your user has sufficient permissions to create and manage sandboxes

### TF2 or Steam Issues
- Verify Steam and TF2 paths in `config.json`
- Check that Steam is running properly outside of any sandbox
- Verify TF2 launches correctly outside of the panel

## Security

This panel contains sensitive files, including:
- Steam account credentials
- Cheat/injection modules

Do not share these files or expose the panel to untrusted networks.

## Disclaimer

This software is provided for educational purposes only. Using cheats or bots in multiplayer games may violate the game's terms of service and could result in account termination. Use at your own risk. 