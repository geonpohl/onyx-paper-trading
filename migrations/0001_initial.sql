PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  balance_cents INTEGER NOT NULL DEFAULT 100000 CHECK (balance_cents >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  market_symbol TEXT NOT NULL,
  market_name TEXT NOT NULL,
  sport TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
  shares REAL NOT NULL CHECK (shares > 0),
  fill_price REAL NOT NULL CHECK (fill_price > 0 AND fill_price < 1),
  cost_cents INTEGER NOT NULL CHECK (cost_cents > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX orders_user_created_idx ON orders(user_id, created_at DESC);
CREATE INDEX orders_user_position_idx ON orders(user_id, market_symbol, side);

CREATE TRIGGER orders_require_balance
BEFORE INSERT ON orders
FOR EACH ROW
WHEN (SELECT balance_cents FROM users WHERE id = NEW.user_id) < NEW.cost_cents
BEGIN
  SELECT RAISE(ABORT, 'insufficient funds');
END;

CREATE TRIGGER orders_debit_balance
AFTER INSERT ON orders
FOR EACH ROW
BEGIN
  UPDATE users
  SET balance_cents = balance_cents - NEW.cost_cents
  WHERE id = NEW.user_id;
END;
