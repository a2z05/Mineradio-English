# Mineradio Remote

Control the Mineradio desktop player from your phone.

1. Open the PC app's settings panel and scan the QR code it shows (it encodes `http://<pc-ip>:<port>/remote/#pair=<token>`).
2. Pairing is one-time: the phone stores a device token locally; re-pair only if the PC app restarts (tokens are in-memory).
3. The PC and the phone must be on the same Wi-Fi / LAN network.

Troubleshooting:
- Cannot connect? Make sure both devices share the same network (phone hotspots usually block this).
- Windows Firewall may block Node.js — allow it on Private networks when prompted.
- If pairing fails, get a fresh QR code from the PC app; codes expire on app restart.
