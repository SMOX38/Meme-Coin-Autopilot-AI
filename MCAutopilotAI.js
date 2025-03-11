// ==============================================
// MCAutopilotAI - Automated Solana Trading System
// Developer: SmoX
// Version: 1.4.0
// ==============================================

require('dotenv').config();
const axios = require('axios');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { Jupiter, SwapMode } = require('@jup-ag/api'); // Updated to use @jup-ag/api
const sqlite3 = require('sqlite3').verbose();
const rateLimit = require('axios-rate-limit');

// Initialize rate-limited axios instance
const http = rateLimit(axios.create(), { 
  maxRequests: 30,
  perMilliseconds: 60000
});

// Validate environment variables
const requiredEnvVars = ['RPC_ENDPOINT', 'PRIVATE_KEY', 'BUY_AMOUNT', 'SLIPPAGE', 'CHECK_INTERVAL'];
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`❌ Critical Error: Missing ${varName} in .env file`);
    process.exit(1);
  }
});

// Initialize database with error handling
const db = new sqlite3.Database('trades.db', (err) => {
  if (err) {
    console.error('🚨 Database Error:', err.message);
    process.exit(1);
  }
  db.run(`CREATE TABLE IF NOT EXISTS positions (
    address TEXT PRIMARY KEY,
    symbol TEXT,
    entry_price REAL,
    amount REAL,
    status TEXT CHECK(status IN ('open', 'closed', 'liquidated')) DEFAULT 'open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS trade_history (
    tx_id TEXT PRIMARY KEY,
    pair_address TEXT,
    direction TEXT,
    amount REAL,
    price REAL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Initialize Solana connection
const connection = new Connection(process.env.RPC_ENDPOINT, {
  commitment: 'confirmed',
  wsEndpoint: process.env.RPC_ENDPOINT.replace('https', 'wss')
});

// Secure wallet initialization
let wallet;
try {
  wallet = Keypair.fromSecretKey(Buffer.from(process.env.PRIVATE_KEY, 'hex'));
  console.log(`🔐 Wallet: ${wallet.publicKey.toString()}`);
} catch (error) {
  console.error('❌ Wallet Error:', error.message);
  process.exit(1);
}

// Trading parameters
const TRADING_PARAMETERS = {
  MIN_MARKET_CAP: 100000,    // $100k
  MIN_LIQUIDITY: 30000,      // $30k
  MIN_VOLUME: 300000,        // $300k
  STOP_LOSS_PERCENT: 15,      // 15% loss
  TAKE_PROFIT_PERCENT: 30,     // 30% gain
  MAX_DAILY_TRADES: 5,
  KEYWORDS: ['doge', 'shib', 'floki', 'bonk', 'samo', 'woof', 'pepe']
};

let dailyTradeCount = 0;

// Helper functions
async function fetchMarketData(maxRetries = 3, retryDelay = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await http.get('https://api.dexscreener.com/latest/dex/pairs/solana', {
        timeout: 10000
      });
      return response.data.pairs.filter(p => 
        p.chainId === 'solana' &&
        p.liquidity.usd >= TRADING_PARAMETERS.MIN_LIQUIDITY &&
        p.volume.h24 >= TRADING_PARAMETERS.MIN_VOLUME
      );
    } catch (error) {
      if (attempt === maxRetries) throw error;
      await new Promise(r => setTimeout(r, retryDelay * attempt));
    }
  }
}

function isMemeCoinCandidate(pair) {
  const keywords = TRADING_PARAMETERS.KEYWORDS;
  const symbol = pair.baseToken.symbol.toLowerCase();
  const name = pair.baseToken.name.toLowerCase();
  
  return keywords.some(kw => symbol.includes(kw) || name.includes(kw));
}

async function verifyTokenSafety(mintAddress) {
  try {
    const [rugCheck, honeypotCheck] = await Promise.all([
      http.get(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/scan`),
      http.get(`https://api.honeypot.is/v2/IsHoneypot?address=${mintAddress}`)
    ]);

    return !rugCheck.data.isHoneypot &&
           rugCheck.data.riskScore < 50 &&
           honeypotCheck.data.isHoneypot === false;
  } catch (error) {
    console.error('🔒 Security Check Error:', error.message);
    return false;
  }
}

async function executeSwap(inputMint, outputMint, amount) {
  if (process.env.DRY_RUN === 'true') {
    console.log(`📝 Dry Run: Would swap ${amount} lamports`);
    return 'simulated-tx-id';
  }

  try {
    const jupiter = await Jupiter.load({
      connection,
      cluster: 'mainnet-beta',
      user: wallet
    });

    const routes = await jupiter.computeRoutes({
      inputMint: new PublicKey(inputMint),
      outputMint: new PublicKey(outputMint),
      inputAmount: amount,
      slippageBps: parseInt(process.env.SLIPPAGE),
      swapMode: SwapMode.ExactIn
    });

    if (!routes.routesInfos.length) {
      throw new Error('No valid routes found');
    }

    const bestRoute = routes.routesInfos.reduce((best, current) => 
      current.outputAmount > best.outputAmount ? current : best
    );

    const { swapTransaction } = await jupiter.exchange({
      routeInfo: bestRoute
    });

    const txid = await sendAndConfirmTransaction(
      connection,
      swapTransaction,
      [wallet],
      { commitment: 'confirmed' }
    );

    return txid;
  } catch (error) {
    console.error('💥 Swap Error:', error.message);
    throw error;
  }
}

// ====================
// Position Management
// ====================

async function monitorPosition(pairAddress, entryPrice) {
  const stopLossPrice = entryPrice * (1 - TRADING_PARAMETERS.STOP_LOSS_PERCENT / 100);
  const takeProfitPrice = entryPrice * (1 + TRADING_PARAMETERS.TAKE_PROFIT_PERCENT / 100);

  const interval = setInterval(async () => {
    try {
      const response = await http.get(`https://api.dexscreener.com/latest/dex/pairs/${pairAddress}`);
      const currentPrice = parseFloat(response.data.pair.priceUsd);

      if (currentPrice <= stopLossPrice || currentPrice >= takeProfitPrice) {
        clearInterval(interval);
        await closePosition(pairAddress, currentPrice);
      }
    } catch (error) {
      console.error('📉 Monitoring Error:', error.message);
    }
  }, 60000);
}

async function closePosition(pairAddress, exitPrice) {
  try {
    const position = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM positions WHERE address = ?', [pairAddress], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!position) {
      console.error('Position not found');
      return;
    }

    const txid = await executeSwap(
      position.token_mint,
      'So11111111111111111111111111111111111111112',
      position.amount
    );

    await db.run(
      'UPDATE positions SET status = ? WHERE address = ?',
      ['closed', pairAddress]
    );

    await logTradeHistory({
      txid,
      pairAddress,
      direction: 'SELL',
      amount: position.amount,
      price: exitPrice
    });

    console.log(`✅ Position closed: ${txid}`);
  } catch (error) {
    console.error('🛑 Close Position Error:', error.message);
  }
}

// ====================
// Utility Functions
// ====================

async function logTradeHistory({ txid, pairAddress, direction, amount, price }) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO trade_history (tx_id, pair_address, direction, amount, price)
       VALUES (?, ?, ?, ?, ?)`,
      [txid, pairAddress, direction, amount, price],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

async function getSolBalance() {
  const balance = await connection.getBalance(wallet.publicKey);
  return balance / LAMPORTS_PER_SOL;
}

// ====================
// Main Trading Cycle
// ====================
async function executeTradingCycle() {
  try {
    if ((await getSolBalance()) < parseFloat(process.env.BUY_AMOUNT) * LAMPORTS_PER_SOL) {
      console.log('⚠️ Insufficient SOL balance');
      return;
    }

    const pairs = await fetchMarketData();
    const storedPairs = await new Promise(resolve => {
      db.all('SELECT address FROM positions', (err, rows) => {
        resolve(new Set(rows.map(r => r.address)));
      });
    });

    const newOpportunities = pairs.filter(p => 
      !storedPairs.has(p.pairAddress) &&
      isMemeCoinCandidate(p) &&
      p.liquidity.usd >= TRADING_PARAMETERS.MIN_LIQUIDITY &&
      p.volume.h24 >= TRADING_PARAMETERS.MIN_VOLUME
    );

    for (const opportunity of newOpportunities.slice(0, TRADING_PARAMETERS.MAX_DAILY_TRADES)) {
      if (await verifyTokenSafety(opportunity.baseToken.address)) {
        const txid = await executeSwap(
          'So11111111111111111111111111111111111111112',
          opportunity.baseToken.address,
          parseFloat(process.env.BUY_AMOUNT) * LAMPORTS_PER_SOL
        );

        if (txid) {
          await db.run(
            `INSERT INTO positions (address, symbol, entry_price, amount) VALUES (?, ?, ?, ?)`,
            [opportunity.pairAddress, opportunity.baseToken.symbol, opportunity.priceUsd, parseFloat(process.env.BUY_AMOUNT)]
          );
          monitorPosition(opportunity.pairAddress, opportunity.priceUsd);
          await logTradeHistory({
            txid,
            pairAddress: opportunity.pairAddress,
            direction: 'BUY',
            amount: parseFloat(process.env.BUY_AMOUNT),
            price: opportunity.priceUsd
          });
        }
      }
    }
  } catch (error) {
    console.error('🚨 Trading cycle error:', error.message);
  }
}

// ==============
// BOT INITIALIZE
// ==============
console.log('🚀 Starting trading bot...');
setInterval(executeTradingCycle, parseInt(process.env.CHECK_INTERVAL));