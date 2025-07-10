#!/usr/bin/env python3
# Make sure you install dependencies first:
# pip3 install -U steam[client]
# If it doesnt work try running on windows and dont bother with installing dependencies on linux

import json
import time
import random
import steam.client
import string
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

f = open('accounts.txt', 'r')
data = f.read()
f.close()

data = data.replace('\r\n', '\n')
accounts = data.split('\n')
accounts = [account for account in accounts if account.strip()]

## Change stuff below to your liking.
profile = open('image.jpg', 'rb')
default_nickname = 'cutie'

enable_debugging = True # Debug info toggle.
enable_extra_info = True # Yap info toggle.
enable_avatarchange = False # Toggle for changing the avatars. This does not work.
enable_namechange = False # Toggle for changing the nicks.
enable_nameclear = False # Clears the prev nick list.  This does not work.
enable_set_up = False # Sets up the profile. Useless.
enable_gatherid32 = False # Collects steam32 ids of the accounts.
dump_response = False # I can only guess what this does.
make_commands = False # Changes steamids to cat_ignore *id* FRIEND commands.
force_sleep = False # Too lazy to know what this does!
Randomname = False  # Toggle this to generate random account names
InsertRandomChars = False  # Toggle this to insert random characters into the nickname
random_name_length = 32  # Length of the random account name
random_chars = [ '็', '่', '๊', '๋', '์', 'ู']  # Modify this list as you wish currently holds random semi-invis symbols for tf2
loopupdateprofiles = False  # Toggle this to loop profile updates
update_interval = 120  # Time to wait between updates in seconds

max_concurrent_threads = 1  # Number of accounts to process simultaneously
thread_delay = 1  # Delay between starting threads to avoid rate limiting

file_lock = threading.Lock()

def debug(message):
    if enable_debugging:
        print(f"[{threading.current_thread().name}] {message}")

def extra(message):
    if enable_extra_info:
        print(f"[{threading.current_thread().name}] {message}")

def insert_random_chars(name, chars, num_insertions):
    name_list = list(name)
    for _ in range(num_insertions):
        pos = random.randint(0, len(name_list))
        char = random.choice(chars)
        name_list.insert(pos, char)
    return ''.join(name_list)

def generate_random_string(length):
    return ''.join(random.choices(string.ascii_letters + string.digits, k=length))

def safe_write_to_file(filename, content, mode='a'):
    """Thread-safe file writing"""
    with file_lock:
        with open(filename, mode) as f:
            f.write(content)

def process_account(account_info):
    """Process a single account - this runs in a separate thread"""
    index, account = account_info
    username, password = account.split(':')
    thread_name = threading.current_thread().name
    
    print(f'[{thread_name}] Processing account #{index + 1}/{len(accounts)} ({username})...')

    # Try to login up to 2 times before giving up on this account
    success = False
    for attempt in range(2):
        client = steam.client.SteamClient()
        eresult = client.login(username, password=password)
        success = (eresult == 1)
        status = 'OK' if success else 'FAIL'
        print(f'[{thread_name}] Login attempt {attempt + 1}: {status} ({eresult})')

        if success:
            # Store successfully logged-in accounts (thread-safe)
            safe_write_to_file('checked.txt', f'{username}:{password}\n')
            break
        else:
            # Brief pause before the second (final) retry
            if attempt == 0:
                time.sleep(5)

    if not success:
        print(f'[{thread_name}] Login failed after 2 attempts; skipping this account.')
        return f"Failed: {username}"

    print(f'[{thread_name}] Logged in as: {client.user.name}')
    print(f'[{thread_name}] Community profile: {client.steam_id.community_url}')
    extra(f'Last logon (UTC): {client.user.last_logon}')
    extra(f'Last logoff (UTC): {client.user.last_logoff}')

    if enable_gatherid32:
        id32 = str(client.steam_id.as_32)
        if make_commands:
            safe_write_to_file('steamid32.txt', f'cat_ignore {id32} FRIEND\n')
            print(f'[{thread_name}] Saved the SteamID32 as a neptune change playerstate command.')
        else:
            safe_write_to_file('steamid32.txt', f'{id32}\n')
            print(f'[{thread_name}] Saved the SteamID32 as raw.')

    if enable_namechange:
        if Randomname:
            nickname = generate_random_string(random_name_length)
        else:
            nickname = default_nickname
        if InsertRandomChars:
            nickname = insert_random_chars(nickname, random_chars, num_insertions)
        time.sleep(5) 
        client.change_status(persona_state=1, player_name=nickname)
        print(f'[{thread_name}] Changed Steam nickname to "{nickname}"')

    if enable_avatarchange or enable_nameclear or enable_set_up:
        print(f'[{thread_name}] Getting web_session...')
        session = client.get_web_session()
        if session is not None:
            debug(f'session.cookies: {session.cookies}')

            if enable_avatarchange:
                # Each thread needs its own profile file handle
                with open('image.jpg', 'rb') as profile_file:
                    url = 'https://steamcommunity.com/actions/FileUploader'
                    id64 = client.steam_id.as_64  # type int
                    data = {
                        'MAX_FILE_SIZE': '1048576',
                        'type': 'player_avatar_image',
                        'sId': str(id64),
                        'sessionid': session.cookies.get('sessionid', domain='steamcommunity.com'),
                        'doSub': '1',
                    }
                    post_cookies = {
                        'sessionid': session.cookies.get('sessionid', domain='steamcommunity.com'),
                        'steamLoginSecure': session.cookies.get('steamLoginSecure', domain='steamcommunity.com')
                    }

                    print(f'[{thread_name}] Setting profile picture...')

                    r = session.post(url=url, params={'type': 'player_avatar_image', 'sId': str(id64)},
                                    files={'avatar': profile_file},
                                    data=data, cookies=post_cookies)
                    content = r.content.decode('ascii')
                    if dump_response:
                        print(f'[{thread_name}] response: {content}')
                    if not content.startswith('<!DOCTYPE html'):
                        response = json.loads(content)
                        if 'message' in response:
                            raise RuntimeError(f'Error setting profile: {response["message"]}')

            if enable_nameclear:
                print(f'[{thread_name}] Clearing nickname history...')
                id64 = client.steam_id.as_64
                r = session.post(f'https://steamcommunity.com/my/ajaxclearaliashistory/',
                                 data={'sessionid': session.cookies.get('sessionid', domain='steamcommunity.com')},
                                 cookies={'sessionid': session.cookies.get('sessionid', domain='steamcommunity.com'),
                                          'steamLoginSecure': session.cookies.get('steamLoginSecure',
                                                                                  domain='steamcommunity.com')})

            if enable_set_up:
                print(f'[{thread_name}] Setting up community profile...')
                r = session.post(f'https://steamcommunity.com/my/edit?welcomed=1',
                                 data={'sessionid': session.cookies.get('sessionid', domain='steamcommunity.com')},
                                 cookies={'sessionid': session.cookies.get('sessionid', domain='steamcommunity.com'),
                                          'steamLoginSecure': session.cookies.get('steamLoginSecure',
                                                                                  domain='steamcommunity.com')})

        else:
            print(f"[{thread_name}] Failed to create a session. Check your authentication or network.")

    print(f'[{thread_name}] Done; logging out.')
    client.logout()
    
    # Add a small delay to avoid overwhelming Steam's servers
    if enable_avatarchange or enable_set_up or force_sleep:
        time.sleep(random.randint(5, 15))  # Random delay to distribute load
    
    return f"Success: {username}"

def update_profiles():
    """Main function to update profiles using multiple threads"""
    print(f"Starting profile updates with {max_concurrent_threads} concurrent threads...")
    
    # Clear the checked accounts file
    with open('checked.txt', 'w') as f:
        pass
    
    # Clear steamid32 file if needed
    if enable_gatherid32:
        with open('steamid32.txt', 'w') as f:
            pass
    
    # Create account info with indices
    account_info_list = [(index, account) for index, account in enumerate(accounts)]
    
    # Use ThreadPoolExecutor to manage concurrent processing
    with ThreadPoolExecutor(max_workers=max_concurrent_threads, thread_name_prefix="SteamWorker") as executor:
        # Submit all tasks with a small delay between submissions
        futures = []
        for i, account_info in enumerate(account_info_list):
            future = executor.submit(process_account, account_info)
            futures.append(future)
            # Add a small delay between starting threads to avoid rate limiting
            if i < len(account_info_list) - 1:  # Don't sleep after the last submission
                time.sleep(thread_delay)
        
        # Wait for all tasks to complete and collect results
        results = []
        for future in as_completed(futures):
            try:
                result = future.result()
                results.append(result)
                print(f"Completed: {result}")
            except Exception as e:
                print(f"Error processing account: {e}")
                results.append(f"Error: {e}")
    
    print(f"All accounts processed. Results summary:")
    successful = len([r for r in results if r.startswith("Success")])
    failed = len([r for r in results if r.startswith("Failed") or r.startswith("Error")])
    print(f"Successful: {successful}, Failed: {failed}")
    print('Done.')

if loopupdateprofiles:
    while True:
        update_profiles()
        print(f'Waiting {update_interval} seconds before next update...')
        time.sleep(update_interval)
else:
    update_profiles()
