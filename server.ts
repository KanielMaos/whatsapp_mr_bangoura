import express from 'express';
import { createServer as createViteServer } from 'vite';
import * as qrcode from 'qrcode';
import * as fs from 'fs';
import * as path from 'path';

// ---- WhatsApp Client Setup (Baileys) ----
import { 
  default as makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  fetchLatestBaileysVersion, 
  WASocket 
} from '@whiskeysockets/baileys';
import pino from 'pino';

const AUTH_PATH = '.wwebjs_auth';

let qrCodeData: string | null = null;
let clientStatus: 'initializing' | 'qr' | 'authenticated' | 'connected' | 'disconnected' = 'initializing';
let lastError: string | null = null;
let sock: WASocket | null = null;

// Custom in-memory store for contacts
const contacts: Record<string, any> = {};

const startBaileys = async () => {
    console.log('[WhatsApp] Initialisation du client Baileys...');
    clientStatus = 'initializing';
    lastError = null;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[WhatsApp] Utilisation de WA v${version.join('.')}, isLatest: ${isLatest}`);

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            generateHighQualityLinkPreview: true,
        });

        sock.ev.on('contacts.upsert', (newContacts) => {
            for (const contact of newContacts) {
                contacts[contact.id] = Object.assign(contacts[contact.id] || {}, contact);
            }
        });

        sock.ev.on('contacts.update', (updates) => {
            for (const update of updates) {
                if (update.id && contacts[update.id]) {
                    Object.assign(contacts[update.id], update);
                } else if (update.id) {
                    contacts[update.id] = update;
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('[WhatsApp] QR Code reçu.');
                clientStatus = 'qr';
                qrCodeData = await qrcode.toDataURL(qr);
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('[WhatsApp] Connexion fermée. Raison:', lastDisconnect?.error, 'Reconnecter:', shouldReconnect);
                clientStatus = 'disconnected';
                lastError = `Disconnected: ${(lastDisconnect?.error as Error)?.message || 'Inconnue'}`;
                qrCodeData = null;
                
                if (shouldReconnect) {
                    setTimeout(startBaileys, 3000);
                } else {
                    console.log('[WhatsApp] Déconnecté volontairement ou session invalide.');
                }
            } else if (connection === 'open') {
                console.log('[WhatsApp] Client connecté et prêt !');
                clientStatus = 'connected';
                qrCodeData = null;
                lastError = null;
            }
        });

    } catch (err: any) {
        console.error('[WhatsApp] Erreur fatale d\'initialisation:', err);
        clientStatus = 'disconnected';
        lastError = `Init Error: ${err.message}`;
    }
};

// ---- Express Server ----
async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json({ limit: '50mb' }));

  /**
   * GET /api/whatsapp/status
   */
  app.get('/api/whatsapp/status', (_req: any, res: any) => {
    res.json({
      status: clientStatus,
      qr: clientStatus === 'qr' ? qrCodeData : null,
    });
  });

  /**
   * GET /api/health
   */
  app.get('/api/health', (_req, res) => {
    res.json({ 
      status: 'ok', 
      whatsappStatus: clientStatus,
      hasQR: !!qrCodeData,
      lastError: lastError,
      env: process.env.NODE_ENV,
      serverTime: new Date().toISOString() 
    });
  });

  /**
   * POST /api/whatsapp/logout
   */
  app.post('/api/whatsapp/logout', async (_req: any, res: any) => {
    try {
      console.log('[WhatsApp] Tentative de déconnexion forcée...');
      
      if (sock) {
        await sock.logout('Log out from API');
      }
      sock = null;
      
      let deleted = false;
      for (let i = 0; i < 5; i++) {
        try {
          if (fs.existsSync(AUTH_PATH)) {
            fs.rmSync(AUTH_PATH, { recursive: true, force: true });
          }
          deleted = true;
          break;
        } catch (err) {
          console.warn(`[WhatsApp] Tentative de suppression ${i+1} échouée, nouvel essai dans 500ms...`);
          await new Promise(r => setTimeout(r, 500));
        }
      }

      if (deleted) console.log('[WhatsApp] Dossier de session supprimé.');

      clientStatus = 'initializing';
      qrCodeData = null;
      startBaileys();

      res.json({ success: true });
    } catch (err) {
      console.error('[WhatsApp] Erreur critique logout:', err);
      res.status(200).json({ success: false, error: String(err) });
    }
  });

  /**
   * GET /api/whatsapp/contacts
   */
  app.get('/api/whatsapp/contacts', async (_req: any, res: any) => {
    if (clientStatus !== 'connected' || !sock) {
      return res.status(503).json({ error: 'Client WhatsApp non connecté.' });
    }
    try {
      const contactsList = Object.values(contacts);
      const personal = contactsList
        .filter((c: any) => c.id && !c.id.includes('@g.us') && !c.id.includes('@newsletter'))
        .map((c: any) => ({
          id: c.id,
          name: c.notify || c.name || c.id.split('@')[0],
          number: c.id.split('@')[0],
        }));
      res.json(personal);
    } catch (err) {
      console.error('[WhatsApp] Erreur getContacts:', err);
      res.status(500).json({ error: 'Impossible de récupérer les contacts.', details: String(err) });
    }
  });

  /**
   * POST /api/whatsapp/check-number
   */
  app.post('/api/whatsapp/check-number', async (req: any, res: any) => {
    if (clientStatus !== 'connected' || !sock) {
      return res.status(503).json({ error: 'Client WhatsApp non connecté.' });
    }
    let { number } = req.body;
    if (!number) {
      return res.status(400).json({ error: 'Paramètre "number" manquant.' });
    }
    
    // Add WhatsApp net suffix if needed
    if (!number.includes('@')) {
      number = `${number}@s.whatsapp.net`;
    }

    try {
      const result = await sock.onWhatsApp(number);
      if (result && result.length > 0 && result[0].exists) {
        res.json({ exists: true, id: result[0].jid });
      } else {
        res.json({ exists: false, id: null });
      }
    } catch (err) {
      res.json({ exists: false, id: null });
    }
  });

  /**
   * POST /api/whatsapp/create-group
   */
  app.post('/api/whatsapp/create-group', async (req: any, res: any) => {
    if (clientStatus !== 'connected' || !sock) {
      return res.status(503).json({ error: 'Client WhatsApp non connecté.' });
    }

    const { groupName, participants } = req.body as { groupName: string; participants: string[] };

    if (!groupName || !Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: 'Paramètres invalides: groupName et participants sont requis.' });
    }

    try {
      console.log(`[WhatsApp] Création du groupe "${groupName}" avec ${participants.length} participant(s)...`);

      const validParticipants: string[] = [];
      const invalidNumbers: string[] = [];
      
      const checkNumber = async (num: string) => {
        let fetchNum = num;
        if (!fetchNum.includes('@')) {
            fetchNum = `${fetchNum}@s.whatsapp.net`;
        }
        try {
          const result = await sock!.onWhatsApp(fetchNum);
          if (result && result.length > 0 && result[0].exists) {
            return { num, id: result[0].jid };
          }
          return { num, id: null };
        } catch {
          return { num, id: null };
        }
      };

      const results = await Promise.all(participants.map(p => checkNumber(p)));
      
      for (const r of results) {
        if (r.id) validParticipants.push(r.id);
        else invalidNumbers.push(r.num);
      }

      if (validParticipants.length === 0) {
        return res.status(400).json({
          error: 'Aucun numéro valide trouvé sur WhatsApp.',
          invalidNumbers,
        });
      }

      const group = await sock.groupCreate(groupName, validParticipants);

      console.log(`[WhatsApp] Groupe créé avec succès: ${group.id}`);

      res.json({
        success: true,
        groupId: group.id,
        groupName,
        addedCount: validParticipants.length,
        invalidNumbers,
      });
    } catch (err) {
      console.error('[WhatsApp] Erreur createGroup:', err);
      res.status(500).json({ error: 'Impossible de créer le groupe.', details: String(err) });
    }
  });

  // ---- Vite Middleware ----
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        watch: {
          ignored: ['**/.wwebjs_auth/**']
        }
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`\n🚀 Serveur démarré sur le port ${PORT}`);
    console.log('📱 Gestion de la connexion WhatsApp en cours...\n');
    
    startBaileys();
  });

  // Handle clean exit
  const cleanup = async () => {
    console.log('\n[WhatsApp] Fermeture propre...');
    try {
      if (sock) {
        sock.end(undefined);
      }
      console.log('[WhatsApp] OK.');
    } catch (e) {
      console.error('[WhatsApp] Erreur lors de la fermeture:', e);
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

startServer();
