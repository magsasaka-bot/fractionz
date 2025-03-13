import fs from "fs/promises";
import WalletManager from "./src/core/wallet.js";
import Tools from "./src/utils/tools.js";
import Display from "./src/utils/display.js";

async function loadConfig() {
  try {
    const data = await fs.readFile("config.json", "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error("❌ Failed to load config.json:", error.message);
    process.exit(1);
  }
}

const config = await loadConfig();

const isAutoMatch = config.matchMode === "auto";

async function loadKeys() {
  try {
    const data = await fs.readFile("./data.txt", "utf8");
    return data.split("\n").filter((key) => key.trim());
  } catch (error) {
    throw new Error(
      "Please create data.txt with your private keys (one per line)"
    );
  }
}

let sessionCount = 0;
let lastSessionTime = null;

async function handleSessionLimit() {
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setHours(now.getHours() + 1, 0, 0, 0);

  const remainingTime = nextHour - now;

  if (remainingTime > 0) {
    const remainingMinutes = Math.ceil(remainingTime / 60000);
    Tools.log(`Session limit reached (${sessionCount}/6). Waiting for ${remainingMinutes} minutes until the next hour...`);

    // Countdown timer
    let remainingSeconds = Math.floor(remainingTime / 1000);
    const countdownInterval = setInterval(() => {
      const minutes = Math.floor(remainingSeconds / 60);
      const seconds = remainingSeconds % 60;
      Tools.log(`Waiting for the next hour to start... [${minutes}:${seconds.toString().padStart(2, '0')} remaining]`);
      remainingSeconds--;

      if (remainingSeconds < 0) {
        clearInterval(countdownInterval);
      }
    }, 1000);

    await Tools.delay(remainingTime, `Waiting for the next hour to start...`);
    clearInterval(countdownInterval);
  }

  sessionCount = 0; // Reset session count
  lastSessionTime = null; // Reset last session time
}

async function runWallet(key) {
  const wallet = new WalletManager(key);

  try {
    // Check session limit before connecting wallet
    if (sessionCount >= 6) {
      Tools.log(`Session limit reached (${sessionCount}/6). Waiting for the next hour...`);
      await handleSessionLimit();
      return await runWallet(key); // Restart after waiting
    }

    await wallet.connect();
    await wallet.getBalance();
    await wallet.login();
    await wallet.getAgents();
    await wallet.getSessions();
    await wallet.getFractalInfo();

    Display.getInstance().updateWallet(wallet);
    Display.getInstance().updateAgents(wallet.agents);
    Display.getInstance().updateFractalInfo(wallet.fractalInfo);

    if (wallet.agents.length === 0) {
      await Tools.delay(
        10000,
        "No agents available. Please create an agent first"
      );
      throw new Error("No agents available");
    }

  
    const targetAgent = wallet.agents.find(agent => agent.name === config.agentName);

    if (!targetAgent) {
      throw new Error(`Target agent ${config.agentName} not found`);
    }

    for (const session of wallet.sessions) {
      if (targetAgent.sessionType.sessionType === session.sessionType.sessionType) {
        if (!targetAgent.automationEnabled) {
          let retryCount = 0;
          const maxRetries = 3; // Maximum number of retries

          while (retryCount < maxRetries) {
            try {
              let startResult;
              if (isAutoMatch) {
                startResult = await wallet.startAutoMatch(targetAgent, session, config.maxGames, config.fee);
              } else {
                startResult = await wallet.startMatch(targetAgent, session);
              }

              if (startResult) {
                sessionCount++;
                lastSessionTime = Date.now();

                Tools.log(`Sessions used: ${sessionCount}/6`);

                if (sessionCount >= 6) {
                  Tools.log("Session limit reached. Waiting for the next hour...");
                  await handleSessionLimit();
                  return await runWallet(key);
                }

                await Tools.delay(2000, "Waiting before next match");
                break; 
              }
            } catch (error) {
              retryCount++;
              Tools.log(`Attempt ${retryCount}/${maxRetries}: ${error.message}`);
              if (retryCount >= maxRetries) {
                Tools.log(`Failed to start match after ${maxRetries} attempts. Skipping...`);
                break; // Exit the retry loop after max retries
              }
              await Tools.delay(10000, "Waiting before retrying...");
            }
          }
        } else {
          Tools.log("Already automated, skip to next agent...");
        }
      }
    }

    let minDuration = 60;
    for (const session of wallet.sessions) {
      const duration =
        session.sessionType.durationPerRound * session.sessionType.rounds;
      if (duration < minDuration) minDuration = duration;
    }

    await Tools.delay(
      minDuration * 1000,
      `Processing completed. Waiting for ${Tools.msToTime(minDuration * 1000)}`
    );

    return await runWallet(key);
  } catch (error) {
    const message = error.message || JSON.stringify(error);

    Tools.log(`Error: ${message}. Retrying in 10s...`);
    await Tools.delay(10000, `Error: ${message}. Retrying in 10s...`);
    return await runWallet(key);
  }
}

async function startBot() {
  try {
    Display.init();
    Display.log("Starting FractionAI Battle BOT...");

    const keys = await loadKeys();
    if (keys.length === 0) {
      throw new Error("No private keys found in data.txt");
    }

    Display.log(`Loaded ${keys.length} wallet(s)`);

    const walletPromises = keys.map((key) => runWallet(key));
    await Promise.all(walletPromises);
  } catch (error) {
    Display.log(`Critical error: ${error.message}`);
    await Tools.delay(5000, "Restarting bot...");
    await startBot();
  }
}

startBot().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});