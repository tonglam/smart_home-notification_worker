# Notification Worker

A Cloudflare Worker for handling notifications with D1 database integration.

## Setup

1. Install dependencies:

```bash
bun install
```

2. Configure D1 Database:

```bash
# Create a new D1 database
wrangler d1 create notification-db

# Update the database_id in wrangler.toml with the ID from the above command
```

3. Apply Database Schema:

```bash
# Apply the schema to your D1 database
wrangler d1 execute notification-db --file=./schema.sql
```

4. Development:

```bash
bun run dev
```

5. Deployment:

```bash
bun run deploy
```

## Database Schema

The application uses a SQLite database (via D1) with the following tables:

1. `devices` - Stores device information and current state
2. `device_states` - Stores device-specific settings and modes
3. `event_log` - Tracks all device and system events
4. `alert_log` - Records and tracks alert statuses

For detailed schema information, see `schema.sql`.

## API Endpoints

- `GET /health` - Health check endpoint
- `GET /` - Main endpoint that tests database connection

## Environment Variables

Make sure to set up the following in your development environment:

- D1 database binding is configured in `wrangler.toml`

## Development

The worker uses:

- Cloudflare Workers for serverless execution
- D1 for database operations (SQLite-compatible)
- Bun for local development and testing
