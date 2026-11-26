-- Migration 0076: support age-based retention pruning of gateway reports.
--
-- Additive and latest: 0075 and its checksum are unchanged. The count cap is
-- enforced on ingest (per gateway, under the gateway row lock) and on read;
-- this index lets the periodic age sweep find expired rows without scanning
-- every gateway's report history.

CREATE INDEX IF NOT EXISTS idx_network_gateway_reports_reported_at
    ON network_gateway_reports (reported_at);
