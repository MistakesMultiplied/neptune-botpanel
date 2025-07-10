import discord
from discord.ext import commands, tasks
import json
import os
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
import time
from typing import Dict, Set
import traceback
import aiohttp
import re
import sys
from discord import app_commands

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('discord_bot.log', encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class ChatRelayBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True
        
        super().__init__(
            command_prefix='!',
            intents=intents,
            help_command=None
        )
        
        # Load configuration
        self.config = self.load_config()
        
        # Configuration
        self.DISCORD_TOKEN = self.config.get('discord_token', 'YOUR_BOT_TOKEN_HERE')
        self.CHANNEL_ID = self.config.get('channel_id', 123456789012345678)
        self.AMALGAM_PATH = os.path.expandvars(r'%APPDATA%\Amalgam')
        
        # Settings
        settings = self.config.get('settings', {})
        self.CHECK_INTERVAL = settings.get('check_interval_seconds', 2)
        self.MAX_MESSAGE_CACHE = settings.get('max_message_cache', 1000)
        self.DEBUG_LOGGING = settings.get('enable_debug_logging', False)
        
        # Experimental: avatar fetching toggle and cache
        self.SHOW_AVATARS = settings.get('show_avatars', False)
        self.avatar_cache: Dict[int, str] = {}
        
        # Formatting
        formatting = self.config.get('formatting', {})
        self.team_colors = {
            k: int(v, 16) if isinstance(v, str) else v 
            for k, v in formatting.get('team_colors', {
                'RED': 0xff4444, 'BLU': 0x4444ff, 'SPEC': 0x888888, 'UNK': 0xcccccc
            }).items()
        }
        self.team_emojis = formatting.get('team_emojis', {
            'RED': '🔴', 'BLU': '🔵', 'SPEC': '👁️', 'UNK': '❓'
        })
        
        # Set debug logging if enabled
        if self.DEBUG_LOGGING:
            logging.getLogger().setLevel(logging.DEBUG)
        
        # State tracking
        self.processed_files: Dict[str, int] = {}  # filename -> last_position
        self.processed_messages: Dict[str, float] = {}  # message hashes to prevent duplicates
        self.target_channel = None
        self.monitor_task = None
        
        # File monitoring
        self.last_check = time.time()
        
        # Register slash command
        @app_commands.command(name="avatars", description="Toggle avatar display on embeds")
        async def avatars_slash(interaction: discord.Interaction):
            self.SHOW_AVATARS = not self.SHOW_AVATARS
            state = 'enabled' if self.SHOW_AVATARS else 'disabled'
            await interaction.response.send_message(f"🖼️ Avatar display {state}.", ephemeral=True)

        self.tree.add_command(avatars_slash)
        
    def load_config(self):
        """Load configuration from config.json"""
        if not os.path.exists('config.json'):
            logger.warning("config.json not found, using default values")
            return {}
            
        # Try multiple encodings
        encodings = ['utf-8', 'utf-8-sig', 'latin1', 'cp1252']
        
        for encoding in encodings:
            try:
                with open('config.json', 'r', encoding=encoding) as f:
                    content = f.read()
                    # Remove any potential BOM or invalid characters
                    content = content.strip()
                    if content.startswith('\ufeff'):
                        content = content[1:]
                    return json.loads(content)
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                logger.debug(f"Failed to load config with encoding {encoding}: {e}")
                continue
            except Exception as e:
                logger.debug(f"Unexpected error with encoding {encoding}: {e}")
                continue
        
        logger.error("Could not load config.json with any encoding, using defaults")
        return {}
        
    async def on_ready(self):
        logger.info(f'Bot connected as {self.user}')
        
        # Get target channel
        self.target_channel = self.get_channel(self.CHANNEL_ID)
        if not self.target_channel:
            logger.error(f"Could not find channel with ID {self.CHANNEL_ID}")
            return
            
        # Safely log channel name without UnicodeEncodeError on Windows consoles
        try:
            channel_display = self.target_channel.name
            sys.stdout.write("")  # ensure stdout present
            channel_display.encode(sys.stdout.encoding or 'utf-8')
        except (UnicodeEncodeError, AttributeError):
            channel_display = channel_display.encode('ascii', 'replace').decode('ascii')
        logger.info(f'Target channel: #{channel_display}')
        
        # Start monitoring task
        await self.start_monitoring()
            
        # Send startup message
        try:
            embed = discord.Embed(
                title="🤖 TF2 Chat Relay Bot",
                description="Now monitoring Amalgam chat logs...",
                color=0x00ff00,
                timestamp=datetime.now(timezone.utc)
            )
            await self.target_channel.send(embed=embed)
        except Exception as e:
            logger.error(f"Failed to send startup message: {e}")

    async def start_monitoring(self):
        """Start the monitoring task if it's not already running."""
        if self.monitor_task and self.monitor_task.is_running():
            return

        @tasks.loop(seconds=self.CHECK_INTERVAL)
        async def monitor_task():
            await self.monitor_chat_logs()

        self.monitor_task = monitor_task
        self.monitor_task.start()
    
    async def monitor_chat_logs(self):
        try:
            # Update last check timestamp
            self.last_check = time.time()
            
            if not self.target_channel:
                return
                
            # Check if Amalgam directory exists
            if not os.path.exists(self.AMALGAM_PATH):
                return
                
            # Find all chat relay log files
            log_files = []
            for file in os.listdir(self.AMALGAM_PATH):
                if file.startswith('chat_relay_') and file.endswith('.log'):
                    log_files.append(os.path.join(self.AMALGAM_PATH, file))
            
            # Process each log file
            for log_file in log_files:
                await self.process_log_file(log_file)
                
        except Exception as e:
            logger.error(f"Error in monitor_chat_logs: {e}")
            logger.error(traceback.format_exc())

    async def process_log_file(self, log_file: str):
        try:
            filename = os.path.basename(log_file)
            
            # Get file size and last position
            if not os.path.exists(log_file):
                return
                
            current_size = os.path.getsize(log_file)

            if filename not in self.processed_files:
                self.processed_files[filename] = current_size

            last_position = self.processed_files.get(filename, 0)

            if current_size < last_position:
                self.processed_files[filename] = current_size
                return

            # If file hasn't grown, nothing to do
            if current_size <= last_position:
                return
            
            # Read new content
            with open(log_file, 'r', encoding='utf-8', errors='ignore') as f:
                f.seek(last_position)
                new_content = f.read()
                
            # Process new lines
            if new_content.strip():
                lines = new_content.strip().split('\n')
                for line in lines:
                    if line.strip():
                        await self.process_chat_message(line.strip())
                        
            # Update position
            self.processed_files[filename] = current_size
            
        except Exception as e:
            logger.error(f"Error processing log file {log_file}: {e}")

    async def process_chat_message(self, json_line: str):
        try:
            # Parse JSON
            data = json.loads(json_line)
            
            # Extract data
            timestamp = data.get('timestamp', '')
            server = data.get('server', 'Unknown Server')
            player = data.get('player', 'Unknown Player')
            team = data.get('team', 'UNK')
            message = data.get('message', '')
            is_team_chat = data.get('teamchat', False)
            steamid32 = data.get('steamid32')
            server_ip = data.get('serverip', '')
            
            # Smarter duplicate prevention: ignore repeated player+message within 4 s
            msg_key = f"{player}:{message}"
            now_ts = time.time()
            last_ts = self.processed_messages.get(msg_key)
            if last_ts and (now_ts - last_ts) < 4:
                return  # duplicate within timeout

            self.processed_messages[msg_key] = now_ts

            # Clean up old entries to keep dict size reasonable
            if len(self.processed_messages) > self.MAX_MESSAGE_CACHE:
                cutoff = now_ts - 10  # keep last ~10 s window for speed
                self.processed_messages = {k: v for k, v in self.processed_messages.items() if v >= cutoff}
            
            # Format and send Discord message with extended details
            await self.send_chat_to_discord(timestamp, server, server_ip, player, team, message, is_team_chat, steamid32)
            
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse JSON: {json_line[:100]}... Error: {e}")
        except Exception as e:
            logger.error(f"Error processing chat message: {e}")

    async def send_chat_to_discord(self, timestamp: str, server: str, server_ip: str, player: str, team: str, message: str, is_team_chat: bool, steamid32: int = None):
        try:
            # Use configured colors and emojis
            color = self.team_colors.get(team, 0xcccccc)
            team_emoji = self.team_emojis.get(team, '❓')
            
            # Chat type indicator
            chat_type = "💬 **TEAM**" if is_team_chat else "🌐 **ALL**"
            
            # Create embed
            embed = discord.Embed(
                color=color,
                timestamp=datetime.now(timezone.utc)
            )
            
            # Format server name (truncate if too long)
            server_display = server[:30] + "..." if len(server) > 30 else server
            
            # Build profile link & avatar (optional)
            profile_url = f"https://steamcommunity.com/profiles/[U:1:{steamid32}]" if steamid32 else None

            icon_url = f"https://via.placeholder.com/32/{team.lower()}/ffffff?text={team[0]}"
            if self.SHOW_AVATARS and steamid32:
                avatar_url = await self.get_avatar_url(steamid32)
                if avatar_url:
                    icon_url = avatar_url

            # Set author (player info)
            embed.set_author(
                name=f"{team_emoji} {player} [{team}]",
                icon_url=icon_url,
                url=profile_url
            )
            
            # Message content
            embed.description = f"{chat_type}\n```{message}```"
            
            # Footer with server and timestamp info
            footer_text = f"📡 {server_display}"
            if server_ip:
                footer_text += f" • {server_ip}"
            footer_text += f" • {timestamp}"

            embed.set_footer(
                text=footer_text,
                icon_url="https://via.placeholder.com/16/ffaa00/ffffff?text=TF2"
            )
            
            # Send to Discord
            await self.target_channel.send(embed=embed)
            
            logger.info(f"Sent message: [{team}] {player}: {message[:50]}...")
            
        except Exception as e:
            logger.error(f"Failed to send message to Discord: {e}")
            # Fallback to simple text message
            try:
                simple_msg = f"`[{team}] {player}:` {message}"
                if is_team_chat:
                    simple_msg = f"**TEAM** {simple_msg}"
                await self.target_channel.send(simple_msg[:2000])  # Discord limit
            except:
                logger.error("Failed to send even simple message")

    async def get_avatar_url(self, steamid32: int):
        """Fetch and cache Steam avatar URL using steamid32."""
        if not steamid32:
            return None

        try:
            steamid32_int = int(steamid32)
        except (ValueError, TypeError):
            return None

        if steamid32_int in self.avatar_cache:
            return self.avatar_cache[steamid32_int]

        steamid64 = 76561197960265728 + steamid32_int
        url = f"https://steamcommunity.com/profiles/{steamid64}?xml=1"

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, timeout=5) as resp:
                    if resp.status != 200:
                        return None
                    text = await resp.text()

            match = re.search(r'<avatarMedium><!\[CDATA\[(.*?)\]\]></avatarMedium>', text)
            if match:
                avatar_url = match.group(1)
                self.avatar_cache[steamid32_int] = avatar_url
                return avatar_url
        except Exception as e:
            if self.DEBUG_LOGGING:
                logger.debug(f"Failed to fetch avatar for {steamid32}: {e}")

        return None

    @commands.command(name='status')
    async def status_command(self, ctx):
        """Check bot status and stats"""
        try:
            # Get stats
            files_monitored = len(self.processed_files)
            total_messages = len(self.processed_messages)
            
            # Check if Amalgam directory exists
            amalgam_exists = os.path.exists(self.AMALGAM_PATH)
            
            # Find current log files
            current_logs = 0
            if amalgam_exists:
                for file in os.listdir(self.AMALGAM_PATH):
                    if file.startswith('chat_relay_') and file.endswith('.log'):
                        current_logs += 1
            
            embed = discord.Embed(
                title="📊 Chat Relay Bot Status",
                color=0x00ff00 if amalgam_exists else 0xff0000,
                timestamp=datetime.now(timezone.utc)
            )
            
            embed.add_field(
                name="🗂️ Monitoring",
                value=f"Files tracked: {files_monitored}\nCurrent logs: {current_logs}",
                inline=True
            )
            
            embed.add_field(
                name="💬 Messages",
                value=f"Processed: {total_messages}\nLast check: {datetime.fromtimestamp(self.last_check).strftime('%H:%M:%S')}",
                inline=True
            )
            
            embed.add_field(
                name="📁 Amalgam Path",
                value=f"{'✅ Found' if amalgam_exists else '❌ Missing'}\n`{self.AMALGAM_PATH}`",
                inline=False
            )
            
            await ctx.send(embed=embed)
            
        except Exception as e:
            await ctx.send(f"❌ Error getting status: {e}")

    @commands.command(name='logs')
    async def logs_command(self, ctx, lines: int = 10):
        """Show recent log entries"""
        try:
            if lines > 50:
                lines = 50
                
            log_content = []
            try:
                with open('discord_bot.log', 'r', encoding='utf-8', errors='ignore') as f:
                    all_lines = f.readlines()
                    recent_lines = all_lines[-lines:]
                    log_content = [line.strip() for line in recent_lines]
            except:
                log_content = ["No log file found"]
            
            if log_content:
                content = '\n'.join(log_content)
                if len(content) > 1900:  # Discord limit with some buffer
                    content = content[-1900:]
                    content = "...\n" + content
                
                embed = discord.Embed(
                    title=f"📝 Recent Log Entries ({lines} lines)",
                    description=f"```\n{content}\n```",
                    color=0xffaa00,
                    timestamp=datetime.now(timezone.utc)
                )
                await ctx.send(embed=embed)
            else:
                await ctx.send("No log entries found.")
                
        except Exception as e:
            await ctx.send(f"❌ Error reading logs: {e}")

    @commands.command(name='reload')
    @commands.has_permissions(administrator=True)
    async def reload_command(self, ctx):
        """Reload the monitoring task"""
        try:
            await self.start_monitoring()
            await ctx.send("✅ Monitoring task running!")
        except Exception as e:
            await ctx.send(f"❌ Error reloading: {e}")

    async def on_command_error(self, ctx, error):
        if isinstance(error, commands.MissingPermissions):
            await ctx.send("❌ You don't have permission to use this command.")
        elif isinstance(error, commands.CommandNotFound):
            pass  # Ignore unknown commands
        else:
            logger.error(f"Command error: {error}")
            await ctx.send(f"❌ An error occurred: {error}")
    
    async def close(self):
        """Clean up when bot shuts down"""
        try:
            if hasattr(self, 'monitor_task') and self.monitor_task:
                self.monitor_task.cancel()
                logger.info("Monitoring task stopped")
        except Exception as e:
            logger.error(f"Error stopping monitoring task: {e}")
        
        await super().close()

    async def setup_hook(self):
        # Sync application commands on startup
        await self.tree.sync()

def main():
    """Main function to run the bot"""
    bot = ChatRelayBot()
    
    # Check configuration
    if bot.DISCORD_TOKEN == "YOUR_BOT_TOKEN_HERE":
        logger.error("Please configure your Discord bot token!")
        logger.error("Edit config.json and set 'discord_token' to your bot token")
        logger.error("Or edit discord_chat_relay.py directly")
        return
        
    if bot.CHANNEL_ID == 123456789012345678:
        logger.error("Please configure your Discord channel ID!")
        logger.error("Edit config.json and set 'channel_id' to your channel ID")
        logger.error("Or edit discord_chat_relay.py directly")
        return
    
    logger.info("Starting TF2 Chat Relay Discord Bot...")
    logger.info(f"Configuration loaded: {len(bot.config)} settings")
    logger.info(f"Monitoring directory: {bot.AMALGAM_PATH}")
    logger.info(f"Target channel ID: {bot.CHANNEL_ID}")
    logger.info(f"Check interval: {bot.CHECK_INTERVAL} seconds")
    
    try:
        bot.run(bot.DISCORD_TOKEN)
    except Exception as e:
        logger.error(f"Failed to start bot: {e}")

if __name__ == "__main__":
    main() 