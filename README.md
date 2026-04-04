# Nelson

A personal AI agent that runs 24/7 on a Mac Mini (or any always-on machine), accessible via Telegram and powered by Claude Code.

Nelson remembers conversations, learns about you over time, and can execute real actions on your machine through Claude Code's tool use.

## Features

- **Telegram interface** — chat with your agent from anywhere
- **Persistent memory** — Nelson remembers what you tell it across conversations
- **Conversation history** — maintains context from recent messages
- **Claude Code powered** — full access to Claude's capabilities including file operations, web search, and code execution
- **Auto-restart** — recovers from crashes automatically via cron health checks
- **Markdown responses** — rich formatting with plain text fallback
- **Single-user** — locked to your Telegram user ID

## Prerequisites

- **Node.js** v18+ — [nodejs.org](https://nodejs.org)
- **Claude Code** — installed and authenticated with a Claude Max subscription
  ```bash
  curl -fsSL https://claude.ai/install.sh | bash
  ```
- **Telegram Bot** — create one via [@BotFather](https://t.me/BotFather)
- **Your Telegram user ID** — get it from [@userinfobot](https://t.me/userinfobot)

## Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/nelson.git
cd nelson
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
TELEGRAM_ALLOWED_USER_ID=your_telegram_user_id
CLAUDE_PATH=/path/to/claude
```

### 4. Create your identity file

```bash
cp CLAUDE.md.example CLAUDE.md
```

Edit `CLAUDE.md` to tell Nelson who you are, what you care about, and how it should behave. This is the system prompt that shapes Nelson's personality and knowledge.

### 5. Initialise data files

```bash
echo '{}' > memory.json
echo '[]' > conversation_history.json
```

### 6. Run

```bash
node nelson.js
```

Send a message to your bot on Telegram — Nelson should respond.

## Running 24/7

### Cron (recommended for macOS)

```bash
crontab -e
```

Add these two lines (adjust paths to match your setup):

```cron
@reboot sleep 60 && cd /path/to/nelson && /usr/local/bin/node nelson.js >> nelson.log 2>&1
*/5 * * * * pgrep -f "node nelson.js" > /dev/null || (cd /path/to/nelson && /usr/local/bin/node nelson.js >> nelson.log 2>&1 &)
```

- **@reboot** — starts Nelson 60s after boot (waits for network)
- ***/5 health check** — restarts Nelson if it crashes

### systemd (Linux)

Create `/etc/systemd/system/nelson.service`:

```ini
[Unit]
Description=Nelson AI Agent
After=network.target

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/nelson
ExecStart=/usr/bin/node nelson.js
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable nelson
sudo systemctl start nelson
```

## How It Works

1. Nelson listens for Telegram messages from your user ID only
2. Loads persistent memory and recent conversation history
3. Passes everything to Claude Code as context
4. Sends the response back via Telegram (with Markdown formatting)
5. In the background, asks Claude to update memory if anything important was said

## Commands

| Command | Action |
|---------|--------|
| `restart` | Restarts the Nelson process |
| Anything else | Processed by Claude as a conversation |

## File Structure

```
nelson/
├── nelson.js              # Main bot script
├── .env                   # Your secrets (gitignored)
├── .env.example           # Template for .env
├── CLAUDE.md              # Your identity/system prompt (gitignored)
├── CLAUDE.md.example      # Template for CLAUDE.md
├── memory.json            # Persistent memory (gitignored)
├── conversation_history.json  # Recent messages (gitignored)
├── package.json
└── README.md
```

## Customisation

### Memory

Nelson's memory is a JSON file that gets updated after each conversation. You can edit `memory.json` directly to seed it with information about yourself, or let Nelson learn organically through conversation.

### System Prompt

`CLAUDE.md` is where you define Nelson's personality and knowledge. The more detail you put here, the better Nelson will understand you from the first message.

### Conversation History

By default, Nelson keeps the last 20 messages for context. Adjust `MAX_HISTORY` in `nelson.js` to change this.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Nelson not responding | Check `nelson.log` for errors |
| "Missing required environment variables" | Ensure `.env` exists with all values |
| Claude not found | Check `CLAUDE_PATH` in `.env` points to the claude binary |
| Markdown rendering errors | Nelson auto-falls back to plain text |
| Bot works but doesn't know who you are | Make sure `CLAUDE.md` exists in the nelson directory |

## Security

- Bot token and user ID are stored in `.env` (gitignored)
- Memory and conversation history are gitignored
- `CLAUDE.md` containing personal information is gitignored
- Only your Telegram user ID can interact with the bot
- Claude runs with `--dangerously-skip-permissions` — be aware this gives it full system access

## License

MIT
