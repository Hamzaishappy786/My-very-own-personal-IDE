<div align="center">
  <img src="https://raw.githubusercontent.com/Hamzaishappy786/hator/main/assets/mascot.png" alt="Hello Everynyan!" width="200"/>

  # Hator

  *a code editor i made because i was tired of vscode being slow*

</div>

---

Hator is a lightweight desktop code editor built with Electron and Monaco (yes, the same editor engine that powers VS Code, ironic, I know). It's fast to open, looks good, and has just the stuff you actually need.

## what it does

- **File tree**: open a folder, browse your files, click to open them in tabs
- **Monaco editor**: syntax highlighting, autocomplete, all that good stuff, for basically every language
- **Tabs**: multiple files open at once, dirty indicator (●) when something's unsaved
- **Auto-save**: saves your file 2 seconds after you stop typing. you won't lose work
- **Integrated terminal**: real shell (PowerShell, CMD on Windows; zsh, bash on Mac/Linux) right inside the editor. Ctrl+` to toggle
- **Git diff gutter**: shows you exactly which lines you added/changed/deleted since the last commit, inline in the editor margin. Updates as you type
- **Run button**: click ▶ to run the current file. Works with Python, Node.js, Ruby, PHP, Go, shell scripts. Output goes straight to your terminal
- **AI error explanations**: when your code crashes, Groq (llama-3.3-70b) reads the error and explains what went wrong in plain English, right below the output
- **Themes**: Dracula, VS Dark, VS Light, One Dark Pro. Switch anytime from Settings
- **Settings modal**: searchable, so you can find things fast

## getting started

You'll need [Node.js](https://nodejs.org) (v18 or later) installed.

```bash
git clone https://github.com/yourusername/hator.git
cd hator
npm install
npm start
```

that's it. the app opens.

## optional: groq api key (for AI error explanations)

The run button's AI explanation feature needs a Groq API key. It's free to get one at [console.groq.com](https://console.groq.com).

Once you have it: open **Settings** (gear icon, bottom-left) → **Integrations** → paste your key into the Groq API Key field. It's saved locally in your browser storage, never sent anywhere except directly to Groq's API when an error occurs.

## running your code

Open a Python/JS/Ruby/etc. file, hit the ▶ button in the toolbar. Hator will:

1. `cd` into the file's directory in the terminal
2. Run it with the right interpreter (`python`, `node`, etc.)
3. Show you the output live
4. If it fails, show a plain-English explanation of what went wrong

## keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+S` | Save current file |
| `Ctrl+`` ` | Toggle terminal |

## tech stack

- **Electron**: desktop shell
- **Monaco Editor**: the actual editor
- **xterm.js + node-pty**: the terminal
- **Tailwind CSS**: styling
- **Groq API**: AI error explanations
- **Myers diff algorithm**: git gutter diffing (runs in a worker thread so it never blocks the UI)

## running tests

```bash
npm test
```

14 unit tests covering the diff engine (Myers algorithm, hunk classification, edge cases).

---

<div align="center">
  <sub>built with way too much free time and a deep personal grudge against slow editors</sub>
</div>
