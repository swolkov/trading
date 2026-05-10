# IBKR Client Portal Gateway — Railway Deployment

## Setup Steps

### 1. Deploy to Railway
```bash
cd ibkr-gateway
railway login
railway init
railway up
```

### 2. Get your Railway URL
After deploy, Railway gives you a public URL like:
`https://ibkr-gateway-production-xxxx.up.railway.app`

### 3. Authenticate (one-time)
Open in browser: `https://YOUR-RAILWAY-URL/`
- Log in with your IBKR paper trading credentials
- Username: your IBKR username
- Password: your IBKR password
- This creates a session that the gateway maintains

### 4. Set Vercel Environment Variables
In Vercel dashboard → Settings → Environment Variables:
- `IBKR_BASE_URL` = `https://YOUR-RAILWAY-URL/v1/api`
- `IBKR_ACCOUNT_ID` = `DUQ851086`

### 5. Re-authenticate periodically
The IBKR session expires after ~24 hours. You'll need to re-authenticate
by visiting the gateway URL in your browser. For fully unattended operation,
consider using the IBKR Web API with OAuth instead.

## Notes
- This runs in paper trading mode by default
- To switch to live trading, change `paperTrading: false` in conf.yaml
- The gateway needs ~512MB RAM minimum
- Health check runs every 30 seconds
