# Smart Home Energy Advisor

An energy monitoring dashboard for Indian homes, built with **zero npm dependencies** — pure Node.js built-ins only.

---

## Quick Start

```bash
# 1. Clone / download the project
# 2. (Optional) Set up watsonx.ai credentials
cp .env.example .env
# Edit .env and fill in your keys

# 3. Run
node server.js

# 4. Open browser
# http://localhost:8080
```

No `npm install` needed. Node.js 18+ required (for built-in `fetch`).

---

## Getting watsonx.ai API Key & Project ID

### API Key
1. Log in to [IBM Cloud](https://cloud.ibm.com)
2. Go to **Manage → Access (IAM) → API keys**
3. Click **Create an IBM Cloud API key**
4. Copy the key and paste it as `WATSONX_API_KEY` in your `.env`

### Project ID
1. Go to [watsonx.ai](https://dataplatform.cloud.ibm.com/wx/home)
2. Open or create a project
3. Click the project → **Manage** tab → **General**
4. Copy the **Project ID** and paste it as `WATSONX_PROJECT_ID` in your `.env`

### Model
The default model is `ibm/granite-3-8b-instruct`. Change `WATSONX_MODEL_ID` in `.env` to use any other available chat model.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Dashboard UI |
| GET | `/api/appliances` | Load sample appliances from CSV |
| POST | `/api/analyze` | Compute energy, bill, load profile |
| POST | `/api/tips` | Get Granite or fallback tips |

### Test with curl

```bash
# Get appliances
curl http://localhost:8080/api/appliances

# Analyze
curl -X POST http://localhost:8080/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"appliances":[{"name":"AC","watts":"1500","quantity":"1","hours_per_day":"8","start_time":"22:00"}]}'

# Tips
curl -X POST http://localhost:8080/api/tips \
  -H "Content-Type: application/json" \
  -d '{"appliances":[{"name":"AC","watts":"1500","quantity":"1","hours_per_day":"8","start_time":"22:00"}]}'
```

---

## MSEDCL Tariff

Rates are defined at the top of `server.js` in the `MSEDCL` config object. Verify against your latest bill or [MSEDCL tariff page](https://www.mahadiscom.in/consumer/tariff/).

---

## Deploy to IBM Cloud Code Engine

### Prerequisites
- [IBM Cloud CLI](https://cloud.ibm.com/docs/cli) + Code Engine plugin: `ibmcloud plugin install code-engine`
- Docker installed (for building the image)
- IBM Container Registry (ICR) access

### Steps

```bash
# 1. Log in to IBM Cloud
ibmcloud login --sso

# 2. Target a resource group and region
ibmcloud target -r us-south -g Default

# 3. Create a Code Engine project (first time only)
ibmcloud ce project create --name energy-advisor

# 4. Select the project
ibmcloud ce project select --name energy-advisor

# 5. Build and push image to IBM Container Registry
ibmcloud cr login
docker build -t us.icr.io/<your-namespace>/energy-advisor:latest .
docker push us.icr.io/<your-namespace>/energy-advisor:latest

# 6. Create a Code Engine application
ibmcloud ce application create \
  --name energy-advisor \
  --image us.icr.io/<your-namespace>/energy-advisor:latest \
  --port 8080 \
  --min-scale 0 \
  --max-scale 2 \
  --env WATSONX_API_KEY=<your-key> \
  --env WATSONX_PROJECT_ID=<your-project-id> \
  --env WATSONX_URL=https://us-south.ml.cloud.ibm.com \
  --env WATSONX_MODEL_ID=ibm/granite-3-8b-instruct

# 7. Get the public URL
ibmcloud ce application get --name energy-advisor --output url
```

### Update a running app

```bash
ibmcloud ce application update \
  --name energy-advisor \
  --image us.icr.io/<your-namespace>/energy-advisor:latest
```

---

## Project Structure

```
.
├── server.js          # Node.js HTTP server (no deps)
├── public/
│   └── index.html     # Single-file dashboard (Chart.js via CDN)
├── data/
│   └── appliances.csv # 12 sample Indian home appliances
├── .env.example       # Environment variable template
├── Dockerfile         # Container image (node:20-alpine)
└── README.md
```

---

## Features

- **Editable appliance table** — add/remove rows, upload CSV
- **Energy analysis** — monthly kWh, % share, top 3 consumers
- **Bill estimate** — MSEDCL residential slab-wise breakdown
- **24-hour load profile** — peak hours highlighted in red
- **30-day usage trend** chart
- **IBM Granite tips** via watsonx.ai REST API (with rule-based fallback)
- **Responsive dashboard** — KPI cards, bar, line, and hourly charts
