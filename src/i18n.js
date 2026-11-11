// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature names, operation modes, the
// status of the integration, the answers of the button and the command
// errors. None of them ever carries the address, the API key or an answer
// of the gateway.
// -----------------------------------------------------------------------------

import { CIRCUIT_ROLES as R, FEATURES as F } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const deviceName = () => both('Boiler (EMS-ESP)', 'Chaudière (EMS-ESP)');

export const FEATURE_NAMES = {
  [F.OUTDOOR]: both('Outdoor temperature', 'Température extérieure'),
  [F.SUPPLY]: both('Supply temperature', 'Température de départ'),
  [F.PRESSURE]: both('System pressure', 'Pression de l’installation'),
  [F.STATUS]: both('Status', 'État de la liaison'),
};

/** "Heating of the boiler, all circuits", "Heating circuit 1", "Hot water 1". */
export function circuitName(circuit) {
  if (circuit === 'heating') {
    return both(
      'Heating of the boiler, all circuits',
      'Chauffage de la chaudière, tous les circuits',
    );
  }
  const n = circuit.replace(/^\D+/, '');
  return circuit.startsWith('hc')
    ? both(`Heating circuit ${n}`, `Circuit de chauffage ${n}`)
    : both(`Hot water ${n}`, `Eau chaude ${n}`);
}

const CIRCUIT_FEATURES = {
  heating: {
    [R.MODE]: both('on/off', 'marche/arrêt'),
  },
  hc: {
    [R.TEMPERATURE]: both('room temperature', 'température ambiante'),
    [R.SETPOINT]: both('room setpoint', 'consigne ambiante'),
    [R.MODE]: both('mode', 'mode'),
  },
  dhw: {
    [R.TEMPERATURE]: both('water temperature', 'température de l’eau'),
    [R.SETPOINT]: both('setpoint', 'consigne'),
    [R.MODE]: both('on/off', 'marche/arrêt'),
  },
};

/** "Heating circuit 1 room setpoint". */
export function circuitFeatureName(circuit, kind, role) {
  const c = circuitName(circuit);
  const f = CIRCUIT_FEATURES[kind][role];
  return both(`${c.en} ${f.en}`, `${c.fr} : ${f.fr}`);
}

/** The modes EMS-ESP lists in English; any other is shown as EMS-ESP names it. */
const MODE_NAMES = {
  off: both('Off', 'Arrêt'),
  on: both('On', 'Marche'),
  auto: both('Automatic (schedule)', 'Automatique (programme)'),
  manual: both('Manual', 'Manuel'),
  day: both('Day', 'Jour'),
  night: both('Night', 'Nuit'),
  nofrost: both('Frost protection', 'Hors gel'),
  eco: both('Eco', 'Éco'),
  'eco+': both('Eco+', 'Éco+'),
  heat: both('Heat', 'Chauffage'),
  cool: both('Cool', 'Rafraîchissement'),
  comfort: both('Comfort', 'Confort'),
  normal: both('Normal', 'Normal'),
  'own prog': both('Own schedule', 'Programme personnel'),
};

/** "Off" of the heating of the boiler: every circuit stops. */
const HEATING_OFF = both(
  'Off: heating of the boiler, all circuits',
  'Arrêt du chauffage de la chaudière, tous les circuits',
);

/** The label of a mode value (plain text, never empty). */
export const modeName = (value, circuit) => {
  if (circuit === 'heating' && value === 'off') {
    return HEATING_OFF;
  }
  return Object.hasOwn(MODE_NAMES, value) ? MODE_NAMES[value] : both(value, value);
};

export const STATUS_TEXTS = {
  online: both('OK', 'OK'),
  offline: both('Gateway unreachable', 'Passerelle injoignable'),
  foreign: both(
    'Another installation answers at this address',
    'Une autre installation répond à cette adresse',
  ),
  unknown: both('State not read', 'État non lu'),
  stopUnsent: (circuit) =>
    both(
      `Stop of ${circuitName(circuit).en} from Gladys not sent yet: sent again at each read`,
      `Arrêt de ${circuitName(circuit).fr} depuis Gladys pas encore envoyé : renvoyé à chaque lecture`,
    ),
  stopRefused: (circuit) =>
    both(
      `Stop of ${circuitName(circuit).en} from Gladys refused 3 times by the gateway: not sent again`,
      `Arrêt de ${circuitName(circuit).fr} depuis Gladys refusé 3 fois par la passerelle : plus renvoyé`,
    ),
  stopUnapplied: (circuit) =>
    both(
      `Stop of ${circuitName(circuit).en} from Gladys sent 3 times, not applied`,
      `Arrêt de ${circuitName(circuit).fr} depuis Gladys envoyé 3 fois, non appliqué`,
    ),
  stopPending: (circuit) =>
    both(
      `Stop of ${circuitName(circuit).en} from Gladys sent, not read yet`,
      `Arrêt de ${circuitName(circuit).fr} depuis Gladys envoyé, pas encore relu`,
    ),
  stopped: (circuit) =>
    both(
      `${circuitName(circuit).en} stopped from Gladys`,
      `${circuitName(circuit).fr} arrêté depuis Gladys`,
    ),
  stopWaitsCredentials: both(
    'A stop from Gladys waits: sent as soon as another API key is saved or the button gets through',
    'Un arrêt depuis Gladys attend : envoyé dès qu’une autre clé d’API est enregistrée ou que le bouton passe',
  ),
};

/** Joins notes with "; ". */
export const notes = (list) =>
  both(list.map((n) => n.en).join('; '), list.map((n) => n.fr).join(' ; '));

/** The connection status texts of the configuration screen. */
export const T = {
  connecting: both('Connecting to the gateway...', 'Connexion à la passerelle...'),
  configWait: (wait) =>
    both(
      `Configuration not read from Gladys; next try in ${wait.en}`,
      `Configuration non lue depuis Gladys ; nouvel essai dans ${wait.fr}`,
    ),
  problem: (problem) => PROBLEMS[problem] ?? PROBLEMS.badAddress,
  refused: both(
    'EMS-ESP refuses the reads with this API key (HTTP 401/403; from version 3.10 every read needs one): stopped, no automatic retry. Check the key, save, or use "Test the connection".',
    'EMS-ESP refuse les lectures avec cette clé d’API (HTTP 401/403 ; depuis la version 3.10 toute lecture en demande une) : arrêt, sans nouvel essai automatique. Vérifiez la clé, enregistrez, ou utilisez « Tester la connexion ».',
  ),
  busy: (wait) =>
    both(
      `The gateway asks to slow down (HTTP 429/5xx): paused, next read in ${wait.en}`,
      `La passerelle demande de ralentir (HTTP 429/5xx) : pause, prochaine lecture dans ${wait.fr}`,
    ),
  unreachable: (reason, wait) =>
    both(
      `Gateway not read (${reason}); next try in ${wait.en}`,
      `Passerelle non lue (${reason}) ; nouvel essai dans ${wait.fr}`,
    ),
  foreign: both(
    'Another installation (another boiler) answers at this address: its values do not go to the device created; check the address',
    'Une autre installation (une autre chaudière) répond à cette adresse : ses valeurs ne vont pas sur l’appareil créé ; vérifiez l’adresse',
  ),
  noIdentity: both(
    'EMS-ESP lists no boiler, heat pump nor thermostat on the EMS bus yet: values not shown',
    'EMS-ESP ne liste encore ni chaudière, ni pompe à chaleur, ni thermostat sur le bus EMS : valeurs non affichées',
  ),
  busDown: both(
    'EMS-ESP answers but its EMS bus is not connected: values not shown (they may be old)',
    'EMS-ESP répond mais son bus EMS n’est pas connecté : valeurs non affichées (elles peuvent être anciennes)',
  ),
  notEmsEsp: both(
    'The answer at this address is not one of EMS-ESP: values not shown',
    'La réponse à cette adresse n’est pas celle d’EMS-ESP : valeurs non affichées',
  ),
  readonly: both(
    'EMS-ESP is in read only mode: it takes every command (HTTP 200) and never applies it, stops included; they show as not applied',
    'EMS-ESP est en mode lecture seule : il accepte toute commande (HTTP 200) sans jamais l’appliquer, arrêts compris ; elles restent non appliquées',
  ),
  fahrenheit: both(
    'EMS-ESP is set to °F: temperatures converted to °C, setpoints refused',
    'EMS-ESP est réglé en °F : températures converties en °C, consignes refusées',
  ),
  connected: (firmware) =>
    both(
      `Connected to EMS-ESP${firmware ? ` ${firmware}` : ''}`,
      `Connecté à EMS-ESP${firmware ? ` ${firmware}` : ''}`,
    ),
  nextRead: (wait) => both(`Next read in ${wait.en}`, `Prochaine lecture dans ${wait.fr}`),
  withNote: (text, note) => {
    const bare = (t) => t.replace(/\.$/, '');
    return both(`${bare(text.en)}. ${bare(note.en)}.`, `${bare(text.fr)}. ${bare(note.fr)}.`);
  },
  unreadable: both(
    '/data unreadable: read again every 10 s; meanwhile nothing is saved, switching on, modes and setpoints are refused (a stop clicked still leaves).',
    '/data illisible : relu toutes les 10 s ; en attendant rien n’est enregistré, remise en marche, modes et consignes sont refusés (un arrêt cliqué part quand même).',
  ),
  test: {
    next: (wait) =>
      both(
        `Read less than an interval ago: next possible in ${wait.en}.`,
        `Lu il y a moins d’un intervalle : prochain essai possible dans ${wait.fr}.`,
      ),
  },
};

const PROBLEMS = {
  noAddress: both(
    'Enter the address of the EMS-ESP gateway (and its API key), then save.',
    'Saisissez l’adresse de la passerelle EMS-ESP (et sa clé d’API), puis enregistrez.',
  ),
  https: both(
    'EMS-ESP answers in plain http: enter its address without https://.',
    'EMS-ESP répond en http simple : saisissez son adresse sans https://.',
  ),
  badAddress: both(
    'Address not valid: an IPv4 address or a host name, with an optional port (192.168.1.50 or 192.168.1.50:8080).',
    'Adresse non valide : une adresse IPv4 ou un nom d’hôte, avec un port facultatif (192.168.1.50 ou 192.168.1.50:8080).',
  ),
  specialAddress: both(
    'This address is a network, broadcast or multicast address: enter the address of the gateway.',
    'Cette adresse est une adresse de réseau, de diffusion ou de multidiffusion : saisissez l’adresse de la passerelle.',
  ),
  badToken: both(
    'API key not valid: printable characters without space, 8 to 1024 (copy it from EMS-ESP, Settings, Security).',
    'Clé d’API non valide : caractères imprimables sans espace, de 8 à 1024 (copiez-la depuis EMS-ESP, Paramètres, Sécurité).',
  ),
};

/** The refusals of the commands (the error Gladys shows). */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  disabled: both(
    'Commands are off: allow them in the configuration of the integration ("Off" needs no option).',
    'Les commandes sont désactivées : autorisez-les dans la configuration de l’intégration (« Arrêt » n’a pas besoin d’option).',
  ),
  badMode: both(
    'This mode is not one this circuit lists.',
    'Ce mode n’est pas un de ceux que liste ce circuit.',
  ),
  noOffHere: both(
    'This heating circuit lists no "Off" mode (its thermostat has none): to stop the heating, use "Heating of the boiler, all circuits" (it stops every circuit). Nothing sent.',
    'Ce circuit de chauffage ne propose pas de mode « Arrêt » (son thermostat n’en a pas) : pour arrêter le chauffage, utilisez « Chauffage de la chaudière, tous les circuits » (il arrête tous les circuits). Rien envoyé.',
  ),
  badNumber: both('Not a number.', 'Ce n’est pas un nombre.'),
  badWhole: both('Whole degrees only.', 'Degrés entiers seulement.'),
  badHalf: both('Half degrees only.', 'Demi-degrés seulement.'),
  outOfRange: (low, high) =>
    both(`Out of range: ${low} to ${high} °C.`, `Hors limites : de ${low} à ${high} °C.`),
  noConfig: both(
    'The configuration of the integration is not read or not valid: nothing sent.',
    'La configuration de l’intégration n’est pas lue ou pas valide : rien envoyé.',
  ),
  foreign: both(
    'Another installation answers at this address: nothing sent.',
    'Une autre installation répond à cette adresse : rien envoyé.',
  ),
  noIdentity: both(
    'The identity of the installation could not be read (no boiler listed by EMS-ESP): nothing sent.',
    'L’identité de l’installation n’a pas pu être lue (aucune chaudière listée par EMS-ESP) : rien envoyé.',
  ),
  refusedAccount: both(
    'EMS-ESP refuses the reads with this API key: nothing sent.',
    'EMS-ESP refuse les lectures avec cette clé d’API : rien envoyé.',
  ),
  paused: both(
    'The gateway asked to slow down (HTTP 429/5xx): nothing sent during the pause.',
    'La passerelle a demandé de ralentir (HTTP 429/5xx) : rien envoyé pendant la pause.',
  ),
  queueFull: both(
    'Too many commands waiting: nothing sent.',
    'Trop de commandes en attente : rien envoyé.',
  ),
  stopped: both(
    'A stop was sent since: this command was not sent.',
    'Un arrêt a été envoyé depuis : cette commande n’a pas été envoyée.',
  ),
  stopHolds: both(
    'This circuit was stopped from Gladys: switch it on (or choose another mode) first (nothing sent).',
    'Ce circuit a été arrêté depuis Gladys : remettez-le en marche (ou choisissez un autre mode) d’abord (rien envoyé).',
  ),
  unreadableData: both(
    '/data cannot be read or written: nothing sent.',
    '/data ne peut être lu ou écrit : rien envoyé.',
  ),
  queueLate: both(
    'Not sent in time, the commands before it took the time: nothing sent.',
    'Pas partie à temps, les commandes avant elle ont pris le temps : rien envoyé.',
  ),
  tooSlow: both(
    'The gateway did not answer in time: nothing sent.',
    'La passerelle n’a pas répondu à temps : rien envoyé.',
  ),
  notRead: (reason) =>
    both(
      `The gateway could not be read (${reason}): nothing sent.`,
      `La passerelle n’a pas pu être lue (${reason}) : rien envoyé.`,
    ),
  missingValue: both(
    'The gateway does not give this value: nothing sent.',
    'La passerelle ne donne pas cette valeur : rien envoyé.',
  ),
  notWritable: both(
    'The gateway says this value is read only: nothing sent.',
    'La passerelle indique que cette valeur est en lecture seule : rien envoyé.',
  ),
  denied: both(
    'EMS-ESP refused the command (HTTP 401/403): an API key with the "Read and Write" right is needed (Settings, Security).',
    'EMS-ESP a refusé la commande (HTTP 401/403) : il faut une clé d’API avec le droit « Lecture et écriture » (Paramètres, Sécurité).',
  ),
  fahrenheit: both(
    'EMS-ESP is set to °F: setpoints are not written from Gladys in this version (nothing sent).',
    'EMS-ESP est réglé en °F : les consignes ne sont pas écrites depuis Gladys dans cette version (rien envoyé).',
  ),
  notSent: (reason) => both(`Not sent (${reason}).`, `Rien envoyé (${reason}).`),
  rejected: (result) =>
    both(
      `The gateway refused the command (${result}).`,
      `La passerelle a refusé la commande (${result}).`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Sent, without confirmation (${reason}): checked by the next reads.`,
      `Envoyée, sans confirmation (${reason}) : vérifiée par les prochaines lectures.`,
    ),
  notYetApplied: both(
    'Sent and accepted, not applied yet: checked by the next reads.',
    'Envoyée et acceptée, pas encore appliquée : vérifiée par les prochaines lectures.',
  ),
  stopUnsent: (reason) =>
    both(
      `Stop not sent (${reason}): sent again at each read until it leaves.`,
      `Arrêt non envoyé (${reason}) : renvoyé à chaque lecture jusqu’à ce qu’il parte.`,
    ),
  stopAfterCredentials: (reason) =>
    both(
      `Stop sent while EMS-ESP refuses the reads with this API key (${reason}): sent again once another key is saved or the button gets through.`,
      `Arrêt envoyé alors qu’EMS-ESP refuse les lectures avec cette clé d’API (${reason}) : renvoyé dès qu’une autre clé est enregistrée ou que le bouton passe.`,
    ),
  stopRejected: (reason) =>
    both(
      `Stop refused by the gateway (${reason}): sent again by the next reads (twice at most).`,
      `Arrêt refusé par la passerelle (${reason}) : renvoyé par les prochaines lectures (2 fois au plus).`,
    ),
  stopDenied: both(
    'Stop refused by EMS-ESP (HTTP 401/403): an API key with the "Read and Write" right is needed (Settings, Security); sent again by the next reads (twice at most).',
    'Arrêt refusé par EMS-ESP (HTTP 401/403) : il faut une clé d’API avec le droit « Lecture et écriture » (Paramètres, Sécurité) ; renvoyé par les prochaines lectures (2 fois au plus).',
  ),
  stopUnconfirmed: (reason) =>
    both(
      `Stop sent, without confirmation (${reason}): checked by the next reads.`,
      `Arrêt envoyé, sans confirmation (${reason}) : vérifié par les prochaines lectures.`,
    ),
  stopNotYet: both(
    'Stop sent and accepted; the gateway has not shown it yet: checked by the next reads.',
    'Arrêt envoyé et accepté ; la passerelle ne l’indique pas encore : vérifié par les prochaines lectures.',
  ),
};
