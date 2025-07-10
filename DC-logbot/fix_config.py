#!/usr/bin/env python3
"""Utility to check and fix config.json encoding issues"""

import json
import os
import sys

def fix_config():
    """Check and fix config.json file"""
    
    if not os.path.exists('config.json'):
        print("Creating default config.json...")
        default_config = {
            "discord_token": "YOUR_BOT_TOKEN_HERE",
            "channel_id": 123456789012345678,
            "settings": {
                "check_interval_seconds": 2,
                "max_message_cache": 1000,
                "enable_debug_logging": False
            },
            "formatting": {
                "team_colors": {
                    "RED": "0xff4444",
                    "BLU": "0x4444ff", 
                    "SPEC": "0x888888",
                    "UNK": "0xcccccc"
                },
                "team_emojis": {
                    "RED": "🔴",
                    "BLU": "🔵",
                    "SPEC": "👁️", 
                    "UNK": "❓"
                }
            }
        }
        
        try:
            with open('config.json', 'w', encoding='utf-8') as f:
                json.dump(default_config, f, indent=2, ensure_ascii=False)
            print("✅ Created default config.json")
            print("Please edit it with your Discord bot token and channel ID!")
            return
        except Exception as e:
            print(f"❌ Error creating config.json: {e}")
            return
    
    print("Checking config.json...")
    
    # Try to read with different encodings
    encodings = ['utf-8', 'utf-8-sig', 'latin1', 'cp1252']
    config_data = None
    working_encoding = None
    
    for encoding in encodings:
        try:
            with open('config.json', 'r', encoding=encoding) as f:
                content = f.read()
                # Remove BOM if present
                if content.startswith('\ufeff'):
                    content = content[1:]
                config_data = json.loads(content)
                working_encoding = encoding
                print(f"✅ Successfully read config.json with {encoding} encoding")
                break
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            print(f"❌ Failed with {encoding}: {e}")
            continue
        except Exception as e:
            print(f"❌ Unexpected error with {encoding}: {e}")
            continue
    
    if not config_data:
        print("❌ Could not read config.json with any encoding!")
        print("The file might be corrupted. Creating a backup and new file...")
        
        try:
            # Backup the old file
            import shutil
            shutil.copy('config.json', 'config.json.backup')
            print("📁 Backed up original to config.json.backup")
            
            # Create new default
            fix_config()  # Recursive call to create default
            return
        except Exception as e:
            print(f"❌ Error creating backup: {e}")
            return
    
    # If we got here, we successfully read the config
    print("✅ Config file is readable!")
    
    # Check if it needs to be re-saved with proper encoding
    if working_encoding != 'utf-8':
        print(f"🔧 Re-saving config.json with UTF-8 encoding (was {working_encoding})...")
        try:
            with open('config.json', 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2, ensure_ascii=False)
            print("✅ Config file re-saved with UTF-8 encoding")
        except Exception as e:
            print(f"❌ Error re-saving config: {e}")
    
    # Check configuration values
    discord_token = config_data.get('discord_token', 'NOT_SET')
    channel_id = config_data.get('channel_id', 0)
    
    print("\nConfiguration check:")
    
    if discord_token == 'YOUR_BOT_TOKEN_HERE':
        print("❌ Discord token not configured")
        print("   Please set 'discord_token' to your actual bot token")
    else:
        print("✅ Discord token is set")
    
    if channel_id == 123456789012345678:
        print("❌ Channel ID not configured")
        print("   Please set 'channel_id' to your actual Discord channel ID")
    else:
        print("✅ Channel ID is set")
    
    if discord_token != 'YOUR_BOT_TOKEN_HERE' and channel_id != 123456789012345678:
        print("\n🎉 Configuration looks good! You can run the bot now.")
    else:
        print("\n⚠️  Please configure the missing values and try again.")

if __name__ == '__main__':
    print("🔧 TF2 Chat Relay - Config Fixer")
    print("=" * 40)
    fix_config() 