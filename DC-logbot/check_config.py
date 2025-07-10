#!/usr/bin/env python3
"""Simple configuration checker for the batch file"""

import json
import sys
import os

def check_config():
    try:
        # Try to load config.json
        config = {}
        if os.path.exists('config.json'):
            try:
                with open('config.json', 'r', encoding='utf-8') as f:
                    config = json.load(f)
            except:
                # If config.json exists but is invalid, use hardcoded values
                pass
        
        # Get token and channel ID
        discord_token = config.get('discord_token', 'YOUR_BOT_TOKEN_HERE')
        channel_id = config.get('channel_id', 123456789012345678)
        
        # Check if configured
        if discord_token == 'YOUR_BOT_TOKEN_HERE':
            print('ERROR: Bot token not configured')
            sys.exit(1)
            
        if channel_id == 123456789012345678:
            print('ERROR: Channel ID not configured')
            sys.exit(1)
            
        print('Configuration OK')
        
    except Exception as e:
        print(f'ERROR: Configuration check failed: {e}')
        sys.exit(1)

if __name__ == '__main__':
    check_config() 