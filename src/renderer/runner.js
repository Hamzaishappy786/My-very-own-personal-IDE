/* global window, document, localStorage, fetch */

/**
 * "Run active file" button. Types the same commands a person would at the
 * prompt -- `cd` into the file's directory, then invoke its interpreter --
 * directly into the real integrated terminal shell (see terminal.js's
 * `runFile`), so output appears exactly like any other terminal run. If
 * that run fails, the captured output is sent to Groq's API for a
 * plain-English explanation instead of leaving the user to parse a raw
 * stack trace alone.
 */
(function () {
  const runBtn = document.getElementById('run-btn');
  if (!runBtn) return;

  const playIcon = document.getElementById('run-icon-play');
  const stopIcon = document.getElementById('run-icon-stop');
  const groqKeyInput = document.getElementById('groq-api-key-input');

  const GROQ_KEY_STORAGE = 'hator-groq-api-key';
  const GROQ_MODEL = 'llama-3.3-70b-versatile';
  const MAX_ERROR_CHARS = 4000;

  let activeFilePath = null;
  let running = false;

  if (groqKeyInput) {
    groqKeyInput.value = localStorage.getItem(GROQ_KEY_STORAGE) || '';
    groqKeyInput.addEventListener('input', () => {
      localStorage.setItem(GROQ_KEY_STORAGE, groqKeyInput.value.trim());
    });
  }

  function isRunnable(filePath) {
    return !!filePath && !!window.HatorTerminalPanel?.isRunnable(filePath);
  }

  function updateButtonState() {
    const runnable = isRunnable(activeFilePath);
    runBtn.disabled = !runnable && !running;
    playIcon.classList.toggle('hidden', running);
    stopIcon.classList.toggle('hidden', !running);

    if (running) {
      runBtn.title = 'Stop running process (Ctrl+C)';
    } else if (runnable) {
      runBtn.title = `Run ${activeFilePath.split(/[\\/]/).pop()}`;
    } else {
      runBtn.title = 'Open a runnable file to enable Run';
    }
  }

  function onActiveFileChanged(filePath) {
    activeFilePath = filePath;
    updateButtonState();
  }

  function write(text) {
    window.HatorTerminalPanel?.writeOutput(text);
  }

  function wrapText(text, width) {
    const lines = [];
    text.split(/\r?\n/).forEach((paragraph) => {
      const words = paragraph.split(/\s+/).filter(Boolean);
      let line = '';
      words.forEach((word) => {
        const candidate = line ? `${line} ${word}` : word;
        if (candidate.length > width) {
          if (line) lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      });
      lines.push(line);
    });
    return lines;
  }

  function writeAiExplanation(text) {
    const width = 58;
    write('\r\n\x1b[36m┌─ Hator AI ─────────────────────────────────\x1b[0m\r\n');
    wrapText(text, width).forEach((line) => write(`\x1b[36m│\x1b[0m ${line}\r\n`));
    write('\x1b[36m└─────────────────────────────────────────────\x1b[0m\r\n');
  }

  async function explainError(errorText) {
    const apiKey = localStorage.getItem(GROQ_KEY_STORAGE);
    if (!apiKey) {
      writeAiExplanation('Add a Groq API key in Settings > Integrations to get plain-English explanations of errors here.');
      return;
    }

    write('\r\n\x1b[90mAsking Groq to explain this error...\x1b[0m\r\n');

    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            {
              role: 'system',
              content:
                'You explain programming errors to a beginner in plain English. Be concise (2-4 sentences): say what went wrong and the concrete fix, e.g. the exact install command for a missing dependency. No jargon, no code fences unless a shell command is needed. Never mention other editors or IDEs (PyCharm, VS Code, Visual Studio, Vim, etc.) — the user is running Hator, so refer to Hator if you need to mention the editor at all.',
            },
            { role: 'user', content: errorText.slice(-MAX_ERROR_CHARS) },
          ],
          temperature: 0.2,
          max_tokens: 300,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        writeAiExplanation(`Groq request failed (${res.status}). Check your API key in Settings. ${body.slice(0, 200)}`);
        return;
      }

      const json = await res.json();
      const explanation = json.choices?.[0]?.message?.content?.trim();
      writeAiExplanation(explanation || 'Groq returned an empty response.');
    } catch (err) {
      writeAiExplanation(`Could not reach Groq: ${err.message}`);
    }
  }

  async function runActiveFile() {
    if (!isRunnable(activeFilePath)) return;
    running = true;
    updateButtonState();

    const filePath = activeFilePath;

    await window.HatorTerminalPanel?.show();
    const result = await window.HatorTerminalPanel?.runFile(filePath);

    running = false;
    updateButtonState();

    if (!result || result.unsupported || result.interrupted) return;

    if (result.exitCode !== 0) {
      await explainError(result.outputText || `Process exited with code ${result.exitCode}`);
    }
  }

  runBtn.addEventListener('click', () => {
    if (running) {
      window.HatorTerminalPanel?.interrupt();
    } else {
      runActiveFile();
    }
  });

  window.HatorRunner = { onActiveFileChanged };
})();
