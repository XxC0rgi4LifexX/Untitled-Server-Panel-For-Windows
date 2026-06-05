# Untitled Server Panel

Local Minecraft server panel for Windows-style local hosting. (Made in Node.JS)

Quick Note: Extract the zip folder If you are going to edit the source code!

## Run As A Windows Desktop App

Install the desktop dependency once:

```cmd
npm install
```

Then start the Windows-style app:

```cmd
npm run desktop
```

The desktop app opens its own window and starts the local panel server in the background.

## Run In A Browser

```bash
npm start
```

Or:

```bash
node server.js
```

The panel defaults to `http://127.0.0.1:3000`.

If port `3000` is busy in Command Prompt:

```cmd
set PORT=3001 && npm start
```

## What is included

- Local server adder and server process controls
- Live console view
- File browser and inline text editor
- Playit.gg tunnel monitoring by public address
- Optional Playit agent process launcher
- Public website portal with account creation
- Admin settings and account management

## Account flow

- The first account created becomes the admin account.
- Later signups become regular member accounts.
- Admin accounts unlock the server manager, file editor, Playit settings, and website settings.

## Playit.gg notes

- The panel does not create tunnels through a private Playit API.
- Instead, it monitors the public address you configure and can launch the local agent if you provide the command.
- For Playit setup details, see the official docs:
  - [Claim page](https://playit.gg/claim)
  - [Setup docs](https://playit.gg/docs)
