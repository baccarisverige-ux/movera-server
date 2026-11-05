-- contract v0.18.23 (alertDesk.serverDetection) + v0.18.22 (adminLiveEvents): an alert the SERVER finds, solves or
-- reopens reaches the admin screens live as alert.changed (0067 only watches admin_alert_records). The sweep writes
-- a row only when something changed, so every write here is news.
CREATE TRIGGER admin_live_alerts_found AFTER INSERT OR UPDATE ON admin_alerts_live FOR EACH ROW EXECUTE FUNCTION admin_live_simple('alert.changed', 'alert_id');
