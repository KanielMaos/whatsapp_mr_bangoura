import React, { useState, useEffect, useCallback, useRef } from 'react';
import Papa from 'papaparse';
import { 
  CheckCircle2, 
  Upload, 
  Users, 
  MessageSquarePlus, 
  Settings,
  RefreshCw,
  ArrowRight,
  AlertCircle,
  Wifi,
  WifiOff,
  Loader2,
  QrCode,
  RotateCcw
} from 'lucide-react';

// --- Error Boundary Component ---
interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { hasError: false };

  constructor(props: ErrorBoundaryProps) {
    super(props);
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Erreur capturée:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="bg-white p-8 rounded-2xl shadow-xl border border-slate-200 max-w-md w-full text-center">
            <div className="bg-red-100 p-4 rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-6">
              <AlertCircle className="w-8 h-8 text-red-600" />
            </div>
            <h1 className="text-xl font-bold text-slate-900 mb-2">Oups ! Quelque chose a mal tourné.</h1>
            <p className="text-slate-500 mb-8 text-sm">
              Une erreur inattendue est survenue. L'interface a été protégée pour éviter une page blanche.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              Recharger l'application
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- Types ---
interface Contact {
  id: string; // e.g., 1234567890@c.us
  name: string;
  type: 'existing' | 'imported';
}

type ConnectionStatus = 'initializing' | 'qr' | 'authenticated' | 'connected' | 'disconnected';

// --- API Helpers ---
const api = {
  getStatus: async (): Promise<{ status: ConnectionStatus; qr: string | null }> => {
    const res = await fetch('/api/whatsapp/status');
    return res.json();
  },

  logout: async (): Promise<void> => {
    await fetch('/api/whatsapp/logout', { method: 'POST' });
  },

  getContacts: async (): Promise<{ id: string; name: string; number: string }[]> => {
    const res = await fetch('/api/whatsapp/contacts');
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Impossible de récupérer les contacts');
    }
    return res.json();
  },

  checkNumber: async (number: string): Promise<{ exists: boolean; id: string | null }> => {
    const res = await fetch('/api/whatsapp/check-number', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number }),
    });
    return res.json();
  },

  createGroup: async (
    groupName: string,
    participants: string[]
  ): Promise<{ success: boolean; groupId: string; addedCount: number; invalidNumbers: string[] }> => {
    const res = await fetch('/api/whatsapp/create-group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupName, participants }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur lors de la création du groupe');
    return data;
  },
};

// --- Status Badge Component ---
function StatusBadge({ status }: { status: ConnectionStatus }) {
  const config = {
    initializing: { label: 'Initialisation...', color: 'bg-slate-100 text-slate-600', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" /> },
    qr: { label: 'En attente de scan', color: 'bg-amber-100 text-amber-700', icon: <QrCode className="w-3.5 h-3.5" /> },
    authenticated: { label: 'Authentifié (chargement...)', color: 'bg-blue-100 text-blue-700', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" /> },
    connected: { label: 'Connecté', color: 'bg-emerald-100 text-emerald-700', icon: <Wifi className="w-3.5 h-3.5" /> },
    disconnected: { label: 'Déconnecté', color: 'bg-red-100 text-red-700', icon: <WifiOff className="w-3.5 h-3.5" /> },
  }[status];

  if (!config) return null;

  return (
    <div key={status} className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full ${config.color} transition-all duration-300`}>
      <span className="shrink-0">{config.icon}</span>
      <span>{config.label}</span>
    </div>
  );
}

// --- Main App ---
function App() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  
  // Step 1 State
  const [status, setStatus] = useState<ConnectionStatus>('initializing');
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [existingContacts, setExistingContacts] = useState<Contact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isFetchingContacts, setIsFetchingContacts] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Step 2 State
  const [importedContacts, setImportedContacts] = useState<Contact[]>([]);

  // Step 3 State
  const [groupName, setGroupName] = useState('');
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [groupResult, setGroupResult] = useState<string | null>(null);
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  // --- Polling for WhatsApp status ---
  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const fetchContactsOnConnect = useCallback(async () => {
    setIsFetchingContacts(true);
    try {
      const contacts = await api.getContacts();
      const mapped: Contact[] = (contacts || []).map((c) => ({
        id: c?.id || '',
        name: String(c?.name || c?.number || 'Sans nom'),
        type: 'existing' as const,
      })).filter(c => c.id);
      setExistingContacts(mapped);
    } catch (err: any) {
      console.warn('Impossible de récupérer les contacts existants:', err.message);
      // Not blocking - user can still proceed
    } finally {
      setIsFetchingContacts(false);
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;

    const poll = async () => {
      try {
        const data = await api.getStatus();
        setStatus(data.status);
        setQrCode(data.qr);

        if (data.status === 'connected') {
          stopPolling();
          await fetchContactsOnConnect();
        }
      } catch (err) {
        console.error('Erreur de poll:', err);
      }
    };

    poll(); // immediate first call
    pollingRef.current = setInterval(poll, 3000);
  }, [stopPolling, fetchContactsOnConnect]);

  const resetAppState = useCallback(() => {
    setStep(1);
    setStatus('initializing');
    setQrCode(null);
    setExistingContacts([]);
    setImportedContacts([]);
    setSelectedContactIds(new Set());
    setGroupName('');
    setGroupResult(null);
    setError(null);
    if (!pollingRef.current) startPolling();
  }, [startPolling]);

  // --- Memos ---
  const uniqueContacts = React.useMemo(() => {
    const all = [...existingContacts, ...importedContacts];
    // Map with id as key to ensure uniqueness
    const map = new Map<string, Contact>();
    all.forEach(c => {
      if (c && c.id) map.set(c.id, c);
    });
    return Array.from(map.values());
  }, [existingContacts, importedContacts]);

  const filteredContacts = React.useMemo(() => {
    const query = (searchQuery || '').toLowerCase();
    return uniqueContacts.filter(c => {
      if (!c) return false;
      const name = String(c.name || '').toLowerCase();
      const id = String(c.id || '').toLowerCase();
      return name.includes(query) || id.includes(query);
    });
  }, [uniqueContacts, searchQuery]);

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  // Auto-advance to step 2 when connected
  useEffect(() => {
    if (status === 'connected' && step === 1 && !isFetchingContacts) {
      setStep(2);
    }
  }, [status, step, isFetchingContacts]);

  // --- Handlers ---
  const handleLogout = async () => {
    console.log('[App] Clic sur "Changer de compte"');
    setError(null);
    
    try {
      // On lance la requête de déconnexion sans attendre indéfiniment
      const logoutPromise = api.logout();
      
      console.log('[App] Reset immédiat de l\'interface pour éviter le gel...');
      setStep(1);
      setStatus('initializing');
      setQrCode(null);
      setExistingContacts([]);
      setImportedContacts([]);
      setSelectedContactIds(new Set());
      setGroupName('');
      setGroupResult(null);

      await logoutPromise;
      console.log('[App] Logout serveur confirmé.');
      
      // On s'assure que le polling reprend
      if (!pollingRef.current) {
        startPolling();
      }
    } catch (err: any) {
      console.error('[App] Erreur pendant logout:', err);
      // Même en cas d'erreur serveur, on veut au moins que l'interface soit reset
      setStep(1);
      setStatus('disconnected');
      setError(`La déconnexion a rencontré un problème, mais nous avons réinitialisé l'interface : ${err.message}`);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const newContacts: Contact[] = [];

        results.data.forEach((row: any) => {
          let phoneRaw = '';
          let nameRaw = '';

          const phoneKeys = ['phone', 'Phone', 'numero', 'Numero', 'téléphone', 'Telephone', 'whatsapp', 'WhatsApp'];
          const nameKeys = ['name', 'Name', 'nom', 'Nom', 'prénom', 'Prenom', 'contact', 'Contact'];

          for (const key of Object.keys(row)) {
            const lowerKey = key.toLowerCase().trim();
            if (!phoneRaw && phoneKeys.some(pk => lowerKey.includes(pk.toLowerCase()))) {
              phoneRaw = String(row[key]);
            }
            if (!nameRaw && nameKeys.some(nk => lowerKey.includes(nk.toLowerCase()))) {
              nameRaw = String(row[key]);
            }
          }

          if (!phoneRaw) {
            for (const key of Object.keys(row)) {
              const strVal = String(row[key]);
              const val = strVal.replace(/\D/g, '');
              // Détection plus souple : au moins 8 chiffres, ou contenant un '+'
              if ((val.length >= 8 && val.length <= 15) || (strVal.includes('+') && val.length >= 6)) {
                phoneRaw = strVal;
                break;
              }
            }
          }

          let phone = phoneRaw.replace(/\D/g, '');
          if (phoneRaw.startsWith('+')) {
            // Garder l'indicatif si présent avec +
          } else if (phone.startsWith('0') && phone.length === 10) {
            phone = '33' + phone.substring(1);
          }
          
          if (!phone || phone.length < 6) return;

          if (phone.startsWith('0') && phone.length === 10) {
            phone = '33' + phone.substring(1);
          } else if (phone.startsWith('00')) {
            phone = phone.substring(2);
          } else if (phone.startsWith('0') && phone.length > 10) {
            phone = phone.substring(1);
          }

          newContacts.push({
            id: `${phone}@c.us`,
            name: nameRaw.trim() || `Contact ${phone}`,
            type: 'imported',
          });
        });

        if (newContacts.length === 0) {
          Papa.parse(file, {
            header: false,
            skipEmptyLines: true,
            complete: (fallbackResults) => {
              const fallbackContacts: Contact[] = [];
              fallbackResults.data.forEach((row: any) => {
                let phoneRaw = '';
                let nameRaw = '';

                for (let i = 0; i < row.length; i++) {
                  const val = String(row[i]).replace(/\D/g, '');
                  if (val.length >= 8 && !phoneRaw) {
                    phoneRaw = String(row[i]);
                  } else if (!nameRaw && String(row[i]).trim().length > 0) {
                    nameRaw = String(row[i]);
                  }
                }

                let phone = phoneRaw.replace(/\D/g, '');
                if (!phone) return;

                if (phone.startsWith('0') && phone.length === 10) {
                  phone = '33' + phone.substring(1);
                } else if (phone.startsWith('00')) {
                  phone = phone.substring(2);
                }

                fallbackContacts.push({
                  id: `${phone}@c.us`,
                  name: nameRaw.trim() || `Contact ${phone}`,
                  type: 'imported',
                });
              });
              setImportedContacts(fallbackContacts);
            },
          });
        } else {
          setImportedContacts(newContacts);
        }
      },
    });
  };

  const handleAutoName = () => {
    setImportedContacts(prev => prev.map((c, i) => ({
      ...c,
      name: c.name || `Contact Importé ${i + 1}`,
    })));
  };

  const handleCreateGroup = async () => {
    if (!groupName) {
      setError('Veuillez entrer un nom de groupe');
      return;
    }
    if (selectedContactIds.size === 0) {
      setError('Veuillez sélectionner au moins un contact.');
      return;
    }

    setIsCreatingGroup(true);
    setError(null);
    setGroupResult(null);

    try {
      // Extract phone numbers from selected IDs (e.g., "33612345678@c.us" → "33612345678")
      const participants = Array.from(selectedContactIds)
        .filter((id: string) => id.endsWith('@c.us'))
        .map((id: string) => id.replace('@c.us', ''));

      const result = await api.createGroup(groupName, participants);

      let msg = `✅ Groupe "${result.groupId}" créé avec succès !\n${result.addedCount} participant(s) ajouté(s).`;
      if (result.invalidNumbers && result.invalidNumbers.length > 0) {
        msg += `\n\n⚠️ ${result.invalidNumbers.length} numéro(s) non trouvés sur WhatsApp :`;
        msg += `\n${result.invalidNumbers.slice(0, 5).join(', ')}${result.invalidNumbers.length > 5 ? '...' : ''}`;
      }
      setGroupResult(msg);
    } catch (err: any) {
      setError(`Erreur: ${err.message || 'Vérifiez que les numéros sont valides sur WhatsApp.'}`);
    } finally {
      setIsCreatingGroup(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <div className="bg-emerald-500 p-2 rounded-lg">
            <MessageSquarePlus className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">WhatsApp AutoGroup</h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="h-8 flex items-center">
            <StatusBadge status={status} />
          </div>
          
          {(status === 'connected' || status === 'authenticated' || status === 'qr') && (
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all border border-slate-200"
              title="Se déconnecter et changer de compte"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Changer de compte</span>
            </button>
          )}

          <div className="h-6 w-px bg-slate-200" />
          
          <div className="flex items-center gap-4 text-sm font-medium text-slate-500">
            <span className={step >= 1 ? 'text-emerald-600' : ''}>1. Connexion</span>
            <ArrowRight className="w-4 h-4" />
            <span className={step >= 2 ? 'text-emerald-600' : ''}>2. Import</span>
            <ArrowRight className="w-4 h-4" />
            <span className={step >= 3 ? 'text-emerald-600' : ''}>3. Groupe</span>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-6 mt-8">

        {/* Error Banner */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3 text-red-700">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {/* STEP 1: QR Code Connection */}
        {step === 1 && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
            <div className="flex items-center gap-3 mb-2">
              <Settings className="w-6 h-6 text-slate-400" />
              <h2 className="text-2xl font-semibold">Connexion à WhatsApp</h2>
            </div>
            <p className="text-slate-500 mb-8">
              Scannez le QR code avec votre téléphone pour connecter votre compte WhatsApp.
            </p>

            <div className="flex flex-col items-center justify-center py-6 gap-6">
              {status === 'initializing' && (
                <div className="flex flex-col items-center justify-center p-12 text-center">
                  <Loader2 className="w-12 h-12 text-blue-600 animate-spin mb-4" />
                  <p className="text-slate-600 font-medium">Initialisation de la session...</p>
                  <p className="text-slate-400 text-sm mt-2">Cela peut prendre quelques secondes.</p>
                </div>
              )}

              {status === 'authenticated' && (
                <div className="flex flex-col items-center justify-center p-12 text-center">
                  <Loader2 className="w-12 h-12 text-emerald-600 animate-spin mb-4" />
                  <p className="text-slate-600 font-medium">Authentification réussie !</p>
                  <p className="text-slate-400 text-sm mt-2">Démarrage des services WhatsApp...</p>
                </div>
              )}

              {status === 'qr' && qrCode && (
                <div className="flex flex-col items-center gap-4">
                  <div className="p-4 bg-white border-2 border-emerald-200 rounded-2xl shadow-md">
                    <img src={qrCode} alt="QR Code WhatsApp" className="w-64 h-64" />
                  </div>
                  <div className="text-center">
                    <p className="font-semibold text-slate-800">Ouvrez WhatsApp sur votre téléphone</p>
                    <p className="text-sm text-slate-500 mt-1">
                      Allez dans <strong>Paramètres → Appareils liés → Lier un appareil</strong>
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-amber-600 text-sm">
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>En attente du scan...</span>
                  </div>
                </div>
              )}

              {status === 'authenticated' && (
                <div className="flex flex-col items-center gap-4">
                  <Loader2 className="w-12 h-12 text-blue-500 animate-spin" />
                  <p className="font-semibold text-blue-700 text-lg">Authentification réussie !</p>
                  <p className="text-sm text-slate-500 text-center">
                    Chargement de vos contacts et de la session...<br/>
                    Cela peut prendre un moment selon votre compte.
                  </p>
                </div>
              )}

              {status === 'connected' && (
                <div className="flex flex-col items-center gap-4">
                  <div className="bg-emerald-100 p-4 rounded-full">
                    <CheckCircle2 className="w-12 h-12 text-emerald-600" />
                  </div>
                  <p className="font-semibold text-emerald-700 text-lg">WhatsApp connecté !</p>
                  {isFetchingContacts && (
                    <div className="flex items-center gap-2 text-slate-500 text-sm">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Récupération des contacts...</span>
                    </div>
                  )}
                </div>
              )}

              {status === 'disconnected' && (
                <div className="flex flex-col items-center gap-4">
                  <div className="bg-red-100 p-4 rounded-full">
                    <WifiOff className="w-12 h-12 text-red-500" />
                  </div>
                  <p className="font-semibold text-red-700">Connexion perdue</p>
                  <p className="text-sm text-slate-500 text-center">
                    Le serveur tente de se reconnecter. Veuillez patienter...
                  </p>
                  <button
                    onClick={() => { setStatus('initializing'); startPolling(); }}
                    className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium px-4 py-2 rounded-lg transition-colors text-sm"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Réessayer
                  </button>
                </div>
              )}
            </div>

            {/* Instructions side panel */}
            <div className="mt-8 bg-slate-50 border border-slate-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">📱 Comment scanner le QR code ?</h3>
              <ol className="space-y-2 text-sm text-slate-600">
                <li className="flex gap-2"><span className="font-bold text-emerald-600">1.</span> Ouvrez <strong>WhatsApp</strong> sur votre téléphone</li>
                <li className="flex gap-2"><span className="font-bold text-emerald-600">2.</span> Allez dans <strong>Paramètres</strong> (icône ⚙️ ou les 3 points)</li>
                <li className="flex gap-2"><span className="font-bold text-emerald-600">3.</span> Appuyez sur <strong>Appareils liés</strong></li>
                <li className="flex gap-2"><span className="font-bold text-emerald-600">4.</span> Appuyez sur <strong>Lier un appareil</strong></li>
                <li className="flex gap-2"><span className="font-bold text-emerald-600">5.</span> Pointez la caméra vers le QR code ci-dessus</li>
              </ol>
            </div>
          </div>
        )}

        {/* STEP 2: Import CSV */}
        {step === 2 && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <Upload className="w-6 h-6 text-slate-400" />
                  <h2 className="text-2xl font-semibold">Importer de nouveaux contacts</h2>
                </div>
                <span className="bg-emerald-100 text-emerald-700 text-xs font-bold px-3 py-1 rounded-full">
                  {existingContacts.length} contacts existants
                </span>
              </div>

              <p className="text-slate-500 mb-6">
                Importez un fichier CSV contenant les numéros de téléphone (1ère colonne).
                Nous allons les préparer pour les ajouter à votre WhatsApp.
              </p>

              <div className="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center hover:bg-slate-50 transition-colors relative">
                <input
                  type="file"
                  accept=".csv"
                  onChange={handleFileUpload}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <Upload className="w-8 h-8 text-slate-400 mx-auto mb-3" />
                <p className="text-sm font-medium text-slate-700">Cliquez ou glissez un fichier CSV ici</p>
                <p className="text-xs text-slate-500 mt-1">Format attendu : 1 numéro par ligne</p>
              </div>

              {importedContacts.length > 0 && (
                <div className="mt-8">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-slate-800">Aperçu des imports ({importedContacts.length})</h3>
                    <button
                      onClick={handleAutoName}
                      className="text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium px-4 py-2 rounded-lg transition-colors"
                    >
                      Générer des noms auto
                    </button>
                  </div>

                  <div className="border border-slate-200 rounded-xl overflow-hidden max-h-64 overflow-y-auto">
                    <table className="w-full text-sm text-left">
                      <thead className="bg-slate-50 text-slate-500 sticky top-0">
                        <tr>
                          <th className="px-4 py-3 font-medium">Numéro (ID)</th>
                          <th className="px-4 py-3 font-medium">Nom attribué</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {importedContacts.map((c, i) => (
                          <tr key={i} className="bg-white">
                            <td className="px-4 py-3 font-mono text-slate-600">{c.id}</td>
                            <td className="px-4 py-3">
                              <input
                                type="text"
                                value={c.name}
                                onChange={(e) => {
                                  const newContacts = [...importedContacts];
                                  newContacts[i].name = e.target.value;
                                  setImportedContacts(newContacts);
                                }}
                                placeholder="Nom du contact"
                                className="w-full bg-transparent border-b border-transparent hover:border-slate-300 focus:border-emerald-500 outline-none px-1 py-0.5 transition-colors"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-8 flex justify-end">
                    <button
                      onClick={() => {
                        const importedIds = new Set(importedContacts.map(c => c.id));
                        setSelectedContactIds(importedIds);
                        setStep(3);
                      }}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium px-6 py-2.5 rounded-lg transition-colors flex items-center gap-2"
                    >
                      Continuer vers la création du groupe
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              {importedContacts.length === 0 && existingContacts.length > 0 && (
                <div className="mt-6 flex justify-end">
                  <button
                    onClick={() => {
                      const allIds = new Set(existingContacts.map(c => c.id));
                      setSelectedContactIds(allIds);
                      setStep(3);
                    }}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium px-6 py-2.5 rounded-lg transition-colors flex items-center gap-2"
                  >
                    Utiliser les contacts existants
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* STEP 3: Create Group */}
        {/* STEP 3: Create Group */}
        {step === 3 && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
            <div className="flex items-center gap-3 mb-6">
              <Users className="w-6 h-6 text-slate-400" />
              <h2 className="text-2xl font-semibold">Création du Groupe WhatsApp</h2>
            </div>

            <div className="bg-slate-50 rounded-xl p-6 mb-8 border border-slate-100">
              <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4">Sélection des participants</h3>

              <div className="mb-4 flex items-center justify-between gap-4">
                <input
                  type="text"
                  placeholder="Rechercher un nom ou un numéro..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex-1 px-4 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none transition-all text-sm"
                />
                <div className="text-sm font-medium text-slate-600 whitespace-nowrap">
                  <span className="text-emerald-600 font-bold">{selectedContactIds.size}</span> / {uniqueContacts.length} sélectionnés
                </div>
              </div>

              <div className="border border-slate-200 rounded-xl overflow-hidden bg-white flex flex-col h-80">
                <div className="bg-slate-100 px-4 py-2 border-b border-slate-200 flex items-center justify-between sticky top-0">
                  <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={filteredContacts.length > 0 && filteredContacts.every(c => selectedContactIds.has(c.id))}
                      onChange={() => {
                        const newSelected = new Set(selectedContactIds);
                        const allFilteredSelected = filteredContacts.every(c => newSelected.has(c.id));
                        if (allFilteredSelected) {
                          filteredContacts.forEach(c => newSelected.delete(c.id));
                        } else {
                          filteredContacts.forEach(c => newSelected.add(c.id));
                        }
                        setSelectedContactIds(newSelected);
                      }}
                      className="rounded text-emerald-600 focus:ring-emerald-500 w-4 h-4"
                    />
                    Tout sélectionner (résultats actuels)
                  </label>
                </div>
                <div className="overflow-y-auto flex-1 p-2">
                  {filteredContacts.length === 0 ? (
                    <div className="text-center text-slate-500 py-8 text-sm">Aucun contact trouvé.</div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {filteredContacts.map(c => (
                        <label
                          key={c.id}
                          className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                            selectedContactIds.has(c.id)
                              ? 'bg-emerald-50 border-emerald-200'
                              : 'bg-white border-slate-100 hover:border-slate-300'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={selectedContactIds.has(c.id)}
                            onChange={() => {
                              const newSelected = new Set(selectedContactIds);
                              if (newSelected.has(c.id)) {
                                newSelected.delete(c.id);
                              } else {
                                newSelected.add(c.id);
                              }
                              setSelectedContactIds(newSelected);
                            }}
                            className="rounded text-emerald-600 focus:ring-emerald-500 w-4 h-4"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-slate-800 text-sm truncate">{String(c?.name || 'Sans nom')}</div>
                            <div className="text-xs text-slate-500 font-mono truncate">{String(c?.id || '').replace('@c.us', '')}</div>
                          </div>
                          {c.type === 'imported' && (
                            <span className="shrink-0 bg-blue-100 text-blue-700 text-[10px] font-bold px-2 py-0.5 rounded-full">
                              NOUVEAU
                            </span>
                          )}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Nom du nouveau groupe</label>
                <input
                  type="text"
                  value={groupName}
                  onChange={e => setGroupName(e.target.value)}
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none transition-all"
                  placeholder="ex: Lancement Produit 2026"
                />
              </div>

              <button
                onClick={handleCreateGroup}
                disabled={isCreatingGroup || !groupName || selectedContactIds.size === 0}
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-3 rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {isCreatingGroup ? (
                  <RefreshCw className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    <CheckCircle2 className="w-5 h-5" />
                    Créer le groupe avec {selectedContactIds.size} membres
                  </>
                )}
              </button>

              {groupResult && (
                <div className="mt-4 p-4 bg-emerald-50 border border-emerald-200 rounded-xl flex items-start gap-3 text-emerald-800 animate-in fade-in slide-in-from-top-2">
                  <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5 text-emerald-600" />
                  <p className="text-sm font-medium whitespace-pre-wrap">{groupResult}</p>
                </div>
              )}
            </div>

            <div className="mt-6 text-center">
              <button
                onClick={() => setStep(2)}
                className="text-sm text-slate-500 hover:text-slate-800 font-medium"
              >
                Retour à l'import
              </button>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}

export default function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
