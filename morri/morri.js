// morri.js – il sito Morri: gli occhiali 3D che seguono lo scroll
// (collegato a morri/index.html con <script type="module" src="morri.js">)
//
// - un solo canvas fisso: gli occhiali passano dietro ai testi e davanti al marchio gigante
// - ogni sezione ha uno "stato" degli occhiali (posizione, rotazione, grandezza, esploso, stanghette):
//   scorrendo, gli occhiali passano con calma da uno stato all'altro
// - le lenti sono nere e trasparenti, specchiate: riflettono un cielo azzurro costruito apposta,
//   che gira seguendo il mouse
// - in js/: la pulizia del file (pulizia.js), stanghette ed esploso (meccanica.js)
//   e la prova con la fotocamera (prova.js)

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { pulisci } from './js/pulizia.js';
import { nuovoStato, preparaModello } from './js/meccanica.js';
import { apriProva } from './js/prova.js';

const FILE = 'modelli/morri.glb';
const PESO_FILE = 13956440;   // se il server non dice quanto pesa il file, per la percentuale
const pocoMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ===== I MATERIALI =====
// acetato nero lucido (frontale e aste separati, così nella prova si possono colorare a parte),
// cerniere in metallo canna di fucile, lenti nere trasparenti specchiate azzurre
function creaMaterialiMorri() {
    const acetato = function(nome) {
        return new THREE.MeshPhysicalMaterial({
            name: nome,
            color: 0x0a0a0b,
            roughness: 0.16,
            clearcoat: 1,
            clearcoatRoughness: 0.03,
            side: THREE.DoubleSide
        });
    };
    return {
        frontale: acetato('Frontale'),
        aste: acetato('Aste'),
        cerniere: new THREE.MeshPhysicalMaterial({
            name: 'Cerniere',
            color: 0x34373d,
            metalness: 1,
            roughness: 0.22
        }),
        lenti: new THREE.MeshPhysicalMaterial({
            name: 'Lenti',
            color: 0x07121f,          // nero bluastro: da dentro si vede scuro
            metalness: 0.65,          // lo specchio
            roughness: 0.02,
            transparent: true,
            opacity: 0.84,            // ma resta trasparente
            iridescence: 1,           // la specchiatura cambia colore con l'angolo (sull'azzurro)
            iridescenceIOR: 1.7,
            iridescenceThicknessRange: [260, 420],
            envMapIntensity: 2.4,
            side: THREE.DoubleSide
        })
    };
}

// ===== IL MODELLO =====
// nel file le parti hanno colori "di lavoro": rosso = frontale (e lenti), verde = aste, blu = cerniere
function caricaModelloMorri(avanzamento) {
    return new Promise(function(risolvi, rifiuta) {
        new GLTFLoader().load(FILE, risolvi, function(e) {
            if (avanzamento) avanzamento(e.loaded / (e.total || PESO_FILE));
        }, rifiuta);
    }).then(function(gltf) {
        const modello = gltf.scene;
        const materiali = creaMaterialiMorri();
        const daTogliere = [];
        modello.traverse(function(o) {
            if (!o.isMesh) return;
            const c = o.material.color;
            let parte = null;
            if (c.r > 0.5 && c.g < 0.5 && c.b < 0.5) parte = 'frontale';
            else if (c.g > 0.5 && c.r < 0.5) parte = 'aste';
            else if (c.b > 0.5 && c.r < 0.5) parte = 'cerniere';
            if (parte) {
                o.userData.parte = parte;
                o.material = materiali[parte];
            } else {
                daTogliere.push(o);   // quote e tavole del disegno
            }
        });
        daTogliere.forEach(function(o) { o.removeFromParent(); });

        let pezzi = pulisci(modello, gltf.parser.associations);

        // le lenti: pezzi "rossi" grandi come una lente (larghi 4-7 cm, alti più di 3 cm).
        // nel file la lente sinistra c'è due volte: teniamo solo le lenti che hanno
        // una gemella uguale (stesso numero di punti) dall'altra parte
        const info = function(p) {
            let parte = null, punti = 0;
            p.traverse(function(o) {
                if (!o.isMesh) return;
                parte = o.userData.parte;
                punti += o.geometry.attributes.position.count;
            });
            const box = new THREE.Box3().setFromObject(p);
            return { pezzo: p, parte: parte, punti: punti, box: box, centro: box.getCenter(new THREE.Vector3()), misura: box.getSize(new THREE.Vector3()) };
        };
        const candidate = pezzi.map(info).filter(function(c) {
            return c.parte === 'frontale' && c.misura.x > 0.035 && c.misura.x < 0.07 && c.misura.y > 0.03;
        });
        candidate.forEach(function(c) {
            const gemella = candidate.some(function(altra) {
                return altra !== c && Math.sign(altra.centro.x) !== Math.sign(c.centro.x) && altra.punti === c.punti;
            });
            if (gemella) {
                c.pezzo.traverse(function(o) {
                    if (!o.isMesh) return;
                    o.material = materiali.lenti;
                    o.userData.parte = 'lenti';
                });
            } else {
                c.pezzo.removeFromParent();
            }
        });
        pezzi = pezzi.filter(function(p) { return p.parent; });
        applicaScelta(materiali);   // i colori scelti nello shop (all'inizio: nero e specchio azzurro)
        return { modello: modello, pezzi: pezzi, materiali: materiali };
    });
}

// ===== IL CIELO DA RIFLETTERE =====
// una sfera con una sfumatura (nero in basso, bianco all'orizzonte, azzurro in alto)
// e qualche pannello luminoso: è quello che si specchia nelle lenti e nell'acetato
function creaCielo(renderer) {
    const cielo = new THREE.Scene();
    cielo.add(new THREE.Mesh(
        new THREE.SphereGeometry(10, 64, 32),
        new THREE.ShaderMaterial({
            side: THREE.BackSide,
            vertexShader: 'varying vec3 vPos; void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
            fragmentShader: [
                'varying vec3 vPos;',
                'void main() {',
                '  float h = normalize(vPos).y;',
                '  vec3 basso = vec3(0.015, 0.02, 0.03);',
                '  vec3 orizzonte = vec3(0.78, 0.9, 1.0);',
                '  vec3 alto = vec3(0.08, 0.42, 1.0);',
                '  vec3 c = h > 0.0 ? mix(orizzonte, alto, pow(h, 0.55)) : mix(orizzonte, basso, pow(-h, 0.3));',
                '  gl_FragColor = vec4(c * 1.3, 1.0);',
                '}'
            ].join('\n')
        })
    ));
    // i pannelli luminosi: danno i riflessi netti
    const pannello = function(larghezza, altezza, colore, forza, x, y, z) {
        const m = new THREE.Mesh(
            new THREE.PlaneGeometry(larghezza, altezza),
            new THREE.MeshBasicMaterial({ color: new THREE.Color(colore).multiplyScalar(forza), side: THREE.DoubleSide })
        );
        m.position.set(x, y, z);
        m.lookAt(0, 0, 0);
        cielo.add(m);
    };
    pannello(9, 1.2, '#ffffff', 6, 0, 6, 4);       // una striscia bianca in alto, davanti
    pannello(2.5, 6, '#9ad6ff', 4, -7, 1, 3);      // un pannello azzurro a sinistra
    pannello(2, 4, '#ffffff', 3, 7, 0.5, -2);      // un pannello bianco a destra, dietro
    pannello(1.2, 1.2, '#3d9bff', 8, 3, 3, 6);     // un punto azzurro intenso
    const pmrem = new THREE.PMREMGenerator(renderer);
    return pmrem.fromScene(cielo, 0.02).texture;
}

// ===== LA SCENA =====
const canvas = document.getElementById('scena');
const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scena = new THREE.Scene();
scena.environment = creaCielo(renderer);

// una luce principale per i riflessi e una "di contorno" azzurra da dietro (si vede sul nero)
const luce = new THREE.DirectionalLight(0xffffff, 1.6);
luce.position.set(2, 4, 5);
scena.add(luce);
const contorno = new THREE.DirectionalLight(0x9ad6ff, 2.5);
contorno.position.set(-3, 2, -4);
scena.add(contorno);

const camera = new THREE.PerspectiveCamera(28, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 7);

// perno: il gruppo che si muove con lo scroll. dentro c'è "oggetto", dove meccanica.js mette il modello
const perno = new THREE.Group();
scena.add(perno);
const v = Object.assign(nuovoStato(), { oggetto: new THREE.Group(), pavimento: new THREE.Object3D() });
perno.add(v.oggetto);

// ===== GLI STATI DEGLI OCCHIALI, SEZIONE PER SEZIONE =====
// x, y: posizione (1 = bordo dello schermo); s: grandezza; rx, ry, rz: rotazione;
// esploso, chiuse: da 0 a 1; gira: rotazione continua
const STATI = {
    apertura:          { x: 0,     y: -0.04, s: 1.25, rx: 0.12, ry: 0,     rz: 0,     esploso: 0, chiuse: 0, gira: 0 },
    // la forma: quasi di fronte, per leggere il disegno del frontale
    forma:             { x: 0.45,  y: 0,     s: 1.15, rx: 0.04, ry: -0.12, rz: 0,     esploso: 0, chiuse: 0, gira: 0 },
    // la materia (sezione scura): di tre quarti e da vicino, la luce scorre sull'acetato
    materia:           { x: 0.4,   y: -0.05, s: 1.6,  rx: 0.22, ry: -0.85, rz: 0.08,  esploso: 0, chiuse: 0, gira: 0 },
    // i dettagli: da dietro, per vedere cerniere e interno delle aste
    dettagli:          { x: 0.45,  y: 0,     s: 1.25, rx: 0.35, ry: 2.35,  rz: 0,     esploso: 0, chiuse: 0, gira: 0 },
    costruzioneInizio: { x: 0.42,  y: 0,     s: 0.9,  rx: 0.45, ry: -0.55, rz: 0,     esploso: 0, chiuse: 0, gira: 0 },
    costruzioneFine:   { x: 0.42,  y: 0,     s: 0.85, rx: 0.55, ry: -0.95, rz: 0,     esploso: 1, chiuse: 0, gira: 0 },
    chiusuraInizio:    { x: -0.4,  y: 0,     s: 1.05, rx: 0.28, ry: 0.7,   rz: 0,     esploso: 0, chiuse: 0, gira: 0 },
    chiusuraFine:      { x: -0.4,  y: 0,     s: 1.15, rx: 0.4,  ry: 1.25,  rz: -0.05, esploso: 0, chiuse: 1, gira: 0 },
    misure:            { x: 0.5,   y: 0.42,  s: 0.62, rx: 0.15, ry: 0.35,  rz: 0,     esploso: 0, chiuse: 0, gira: 0 },
    // il progetto (sezione scura): girano piano, come su un tavolo da lavoro
    progetto:          { x: 0.42,  y: 0,     s: 1.0,  rx: 0.5,  ry: -0.4,  rz: 0,     esploso: 0, chiuse: 0, gira: 0.5 },
    // le viste fisse: gli occhiali 3D escono dallo schermo verso l'alto (parlano le immagini)
    viste:             { x: 0.3,   y: 1.9,   s: 0.7,  rx: 0.3,  ry: 0.6,   rz: 0,     esploso: 0, chiuse: 0, gira: 0 },
    // lo shop: a sinistra, grandi, girano piano mentre scegli i colori (il pannello è a destra)
    shop:              { x: -0.42, y: 0,     s: 1.2,  rx: 0.18, ry: 0.5,   rz: 0,     esploso: 0, chiuse: 0, gira: 0.35 },
    prova:             { x: 0.42,  y: 0,     s: 1.1,  rx: 0.12, ry: -0.3,  rz: 0,     esploso: 0, chiuse: 0, gira: 1 }
};
const CHIAVI = Object.keys(STATI.apertura);

// i punti dello scroll in cui gli occhiali raggiungono ogni stato
let tappe = [];
function calcolaTappe() {
    tappe = [];
    document.querySelectorAll('[data-scena]').forEach(function(sezione) {
        const nome = sezione.dataset.scena;
        const alto = sezione.getBoundingClientRect().top + window.scrollY;
        if (sezione.classList.contains('m-lunga')) {
            // sezione lunga: uno stato all'inizio e uno alla fine (in mezzo, esploso o stanghette avanzano)
            tappe.push({ y: alto, stato: STATI[nome + 'Inizio'] });
            tappe.push({ y: alto + sezione.offsetHeight - window.innerHeight, stato: STATI[nome + 'Fine'] });
        } else {
            tappe.push({ y: Math.max(0, alto - window.innerHeight * 0.3), stato: STATI[nome] });
        }
    });
    tappe.sort(function(a, b) { return a.y - b.y; });
}

function morbido(t) {
    t = THREE.MathUtils.clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
}

// lo stato che corrisponde allo scroll di adesso
const obiettivo = Object.assign({}, STATI.apertura);
function statoDelloScroll() {
    const y = window.scrollY;
    if (tappe.length === 0) return;
    let da = tappe[0], a = tappe[0];
    if (y >= tappe[tappe.length - 1].y) {
        da = a = tappe[tappe.length - 1];
    } else {
        for (let i = 0; i < tappe.length - 1; i++) {
            if (y >= tappe[i].y && y < tappe[i + 1].y) {
                da = tappe[i];
                a = tappe[i + 1];
                break;
            }
        }
    }
    const t = da === a ? 0 : morbido((y - da.y) / (a.y - da.y));
    CHIAVI.forEach(function(k) {
        obiettivo[k] = da.stato[k] + (a.stato[k] - da.stato[k]) * t;
    });
}

// ===== IL MOUSE =====
// il cielo riflesso gira seguendo il mouse, e gli occhiali si inclinano appena
const mouse = { x: 0, y: 0, mx: 0, my: 0 };
window.addEventListener('pointermove', function(e) {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
});

// ===== OGNI FOTOGRAMMA =====
const attuale = Object.assign({}, STATI.apertura);
let angoloGiro = 0;
let tempo = 0;
const barraEsploso = document.getElementById('barra-esploso');
const orologio = new THREE.Clock();

// esploso e stanghette: da 0 a 1
function impostaMeccanica(esploso, chiuse) {
    const t = morbido(esploso);
    v.pezzi.forEach(function(p) {
        p.oggetto.position.lerpVectors(p.riunito, p.esploso, t);
    });
    const s = v.perni.sinistra, d = v.perni.destra;
    const c = chiuse * 1.35;   // la seconda stanghetta parte un po' dopo la prima
    if (s) s.rotation.y = s.userData.segno * s.userData.chiusura * morbido(c);
    if (d) d.rotation.y = d.userData.segno * d.userData.chiusura * morbido(c - (s ? 0.35 : 0));
}

function applicaMeccanica() {
    // l'esploso e le stanghette seguono lo scroll (non un bottone)
    impostaMeccanica(attuale.esploso, attuale.chiuse);
    if (barraEsploso) barraEsploso.style.transform = 'scaleX(' + attuale.esploso.toFixed(3) + ')';
}

// ===== LE VISTE FISSE =====
// al caricamento, il renderer "scatta" una foto del modello per ogni casella della griglia:
// stesse luci e stessi materiali del 3D, sfondo trasparente (il colore lo dà la casella)
// w, h: misura della foto; s: grandezza; rx, ry: rotazione; dettaglio: primo piano su un punto
const VISTE = {
    treQuarti: { w: 1100, h: 1100, s: 1.15, rx: 0.25, ry: -0.7 },
    frontale:  { w: 1400, h: 700,  s: 1.25, rx: 0,    ry: 0 },
    profilo:   { w: 700,  h: 700,  s: 0.9,  rx: 0,    ry: Math.PI / 2 },
    alto:      { w: 700,  h: 700,  s: 0.9,  rx: Math.PI / 2, ry: 0 },
    cerniera:  { w: 600,  h: 1200, s: 1,    rx: 0.15, ry: -0.9, dettaglio: 'cerniera', distanza: 1.3 },
    esploso:   { w: 1400, h: 700,  s: 0.95, rx: 0.45, ry: -0.6, esploso: 1 },
    chiusi:    { w: 700,  h: 700,  s: 0.95, rx: 0.35, ry: -0.5, chiuse: 1 },
    dietro:    { w: 1400, h: 700,  s: 1.15, rx: 0.2,  ry: Math.PI - 0.45 },
    ponte:     { w: 700,  h: 700,  s: 1,    rx: 0.05, ry: 0, dettaglio: 'ponte', distanza: 1.2 }
};

// il punto da guardare da vicino (nelle misure della scena)
function puntoDettaglio(nome) {
    if (nome === 'cerniera') {
        const perno = v.perni.destra || v.perni.sinistra;
        if (perno) return perno.getWorldPosition(new THREE.Vector3());
    }
    // il ponte: al centro, nella parte alta del frontale, sul davanti
    const box = new THREE.Box3().setFromObject(v.oggetto);
    return new THREE.Vector3(0, box.max.y - (box.max.y - box.min.y) * 0.3, box.max.z);
}

function fotografaViste() {
    const pixelPrima = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    scena.environmentRotation.set(0, 0.4, 0);
    const davanti = new THREE.Vector3(0, 0.12, 1).normalize();

    document.querySelectorAll('[data-vista]').forEach(function(figura) {
        const vista = VISTE[figura.dataset.vista];
        if (!vista) return;
        renderer.setSize(vista.w, vista.h, false);
        camera.aspect = vista.w / vista.h;

        perno.position.set(0, 0, 0);
        perno.scale.setScalar(vista.s || 1);
        perno.rotation.set(vista.rx || 0, vista.ry || 0, 0);
        impostaMeccanica(vista.esploso || 0, vista.chiuse || 0);
        scena.updateMatrixWorld(true);

        camera.position.set(0, 0, 7);
        camera.lookAt(0, 0, 0);
        if (vista.dettaglio) {
            const punto = puntoDettaglio(vista.dettaglio);
            camera.position.copy(punto).addScaledVector(davanti, vista.distanza);
            camera.lookAt(punto);
        }
        camera.updateProjectionMatrix();
        renderer.render(scena, camera);
        figura.querySelector('img').src = renderer.domElement.toDataURL('image/png');
    });

    // tutto come prima
    renderer.setPixelRatio(pixelPrima);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.position.set(0, 0, 7);
    camera.rotation.set(0, 0, 0);
    camera.updateProjectionMatrix();
    impostaMeccanica(0, 0);
}

function fotogramma() {
    const dt = Math.min(orologio.getDelta(), 0.05);
    tempo += dt;
    statoDelloScroll();

    // gli occhiali raggiungono lo stato con calma (più è alto il numero, più sono rapidi)
    const k = 1 - Math.exp(-dt * 5);
    CHIAVI.forEach(function(chiave) {
        attuale[chiave] += (obiettivo[chiave] - attuale[chiave]) * k;
    });
    mouse.mx += (mouse.x - mouse.mx) * k;
    mouse.my += (mouse.y - mouse.my) * k;

    // la rotazione continua (nella sezione "Provali"); fuori, torna al giro intero più vicino
    angoloGiro += dt * 0.6 * attuale.gira;
    const giroIntero = Math.round(angoloGiro / (Math.PI * 2)) * Math.PI * 2;
    angoloGiro += (giroIntero - angoloGiro) * (1 - attuale.gira) * k;

    // posizione in proporzione allo schermo: sul telefono gli occhiali stanno in alto, al centro
    const mezzaAltezza = camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const mezzaLarghezza = mezzaAltezza * camera.aspect;
    const verticale = camera.aspect < 0.9;
    const scalaSchermo = verticale ? Math.min(1, mezzaLarghezza / 1.25) : 1;
    const ondeggio = pocoMovimento ? 0 : Math.sin(tempo * 0.6) * 0.05;

    perno.position.set(
        verticale ? 0 : attuale.x * mezzaLarghezza,
        verticale ? mezzaAltezza * 0.42 : attuale.y * mezzaAltezza,
        0
    );
    perno.scale.setScalar(attuale.s * scalaSchermo);
    perno.rotation.set(
        attuale.rx + mouse.my * 0.08,
        attuale.ry + angoloGiro + mouse.mx * 0.14 + ondeggio,
        attuale.rz
    );
    scena.environmentRotation.set(mouse.my * 0.25, mouse.mx * 0.9 + tempo * 0.03, 0);

    applicaMeccanica();
    renderer.render(scena, camera);
}

window.addEventListener('resize', function() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    calcolaTappe();
});

// ===== I TESTI CHE ENTRANO =====
// i titoli vengono divisi in parole: ogni parola sale da sotto, una dopo l'altra
function dividiInParole(titolo) {
    const nodi = Array.from(titolo.childNodes);
    titolo.textContent = '';
    let i = 0;
    const parola = function(testo, involucro) {
        const fuori = document.createElement('span');
        fuori.className = 'm-parola';
        const dentro = document.createElement('span');
        dentro.style.setProperty('--i', i++);
        if (involucro) {
            const copia = involucro.cloneNode(false);
            copia.textContent = testo;
            dentro.appendChild(copia);
        } else {
            dentro.textContent = testo;
        }
        fuori.appendChild(dentro);
        return fuori;
    };
    nodi.forEach(function(nodo) {
        const involucro = nodo.nodeType === Node.ELEMENT_NODE ? nodo : null;
        nodo.textContent.split(/(\s+)/).forEach(function(pezzo) {
            if (!pezzo) return;
            if (/^\s+$/.test(pezzo)) titolo.appendChild(document.createTextNode(' '));
            else titolo.appendChild(parola(pezzo, involucro));
        });
    });
}
document.querySelectorAll('[data-dividi]').forEach(dividiInParole);

const osservatore = new IntersectionObserver(function(voci) {
    voci.forEach(function(voce) {
        if (voce.isIntersecting) {
            voce.target.classList.add('visibile');
            osservatore.unobserve(voce.target);
        }
    });
}, { threshold: 0.2 });
document.querySelectorAll('[data-dividi], .m-rivela').forEach(function(el) {
    osservatore.observe(el);
});

// ===== IL CURSORE =====
const cursore = document.querySelector('.m-cursore');
const puntatore = { x: -100, y: -100, cx: -100, cy: -100 };
window.addEventListener('pointermove', function(e) {
    puntatore.x = e.clientX;
    puntatore.y = e.clientY;
    cursore.classList.toggle('sopra-link', Boolean(e.target.closest('a, button')));
});
function muoviCursore() {
    puntatore.cx += (puntatore.x - puntatore.cx) * 0.2;
    puntatore.cy += (puntatore.y - puntatore.cy) * 0.2;
    cursore.style.transform = 'translate(' + puntatore.cx + 'px, ' + puntatore.cy + 'px)';
    requestAnimationFrame(muoviCursore);
}
muoviCursore();

// ===== LO SHOP =====
// le opzioni di ogni parte. extra = quanto costa in più
const PREZZO_BASE = 220;
const OPZIONI = {
    montatura: [
        { id: 'nero',   nome: 'Nero lucido',      colore: '#0a0a0b', ruvido: 0.16, laccato: 1 },
        { id: 'opaco',  nome: 'Nero opaco',       colore: '#141414', ruvido: 0.65, laccato: 0 },
        { id: 'avana',  nome: 'Avana',            colore: '#4a2c17', ruvido: 0.16, laccato: 1 },
        { id: 'blu',    nome: 'Blu notte',        colore: '#0f1a2e', ruvido: 0.16, laccato: 1 },
        { id: 'verde',  nome: 'Verde bottiglia',  colore: '#12261c', ruvido: 0.16, laccato: 1 },
        { id: 'fume',   nome: 'Cristallo fumé',   colore: '#3a3a3c', ruvido: 0.1,  laccato: 1, opacita: 0.72, extra: 20 }
    ],
    lenti: [
        { id: 'azzurro', nome: 'Specchio azzurro', colore: '#07121f', metallo: 0.65, iridescenza: 1, opacita: 0.84, specchio: true, campione: '#5aa9ff', extra: 20 },
        { id: 'argento', nome: 'Specchio argento', colore: '#1b1d20', metallo: 0.9,  iridescenza: 0, opacita: 0.88, specchio: true, campione: '#b9bec6', extra: 20 },
        { id: 'fume',    nome: 'Fumé',             colore: '#161616', metallo: 0.1,  iridescenza: 0, opacita: 0.86 },
        { id: 'marrone', nome: 'Marrone',          colore: '#3a2414', metallo: 0.1,  iridescenza: 0, opacita: 0.82 },
        { id: 'verde',   nome: 'Verde',            colore: '#1d2b1f', metallo: 0.1,  iridescenza: 0, opacita: 0.84 }
    ],
    cerniere: [
        { id: 'canna',   nome: 'Canna di fucile', colore: '#34373d' },
        { id: 'argento', nome: 'Argento',         colore: '#c8c8c8' },
        { id: 'oro',     nome: 'Oro',             colore: '#c9a646' },
        { id: 'nero',    nome: 'Nero',            colore: '#151515' }
    ]
};
const scelta = { montatura: 'nero', lenti: 'azzurro', cerniere: 'canna' };
let materialiPrincipali = null;   // i materiali degli occhiali 3D della pagina

function opzione(gruppo, id) {
    return OPZIONI[gruppo].find(function(o) { return o.id === (id || scelta[gruppo]); });
}

function prezzo(config) {
    return PREZZO_BASE + Object.keys(OPZIONI).reduce(function(somma, gruppo) {
        return somma + (opzione(gruppo, config[gruppo]).extra || 0);
    }, 0);
}

function euro(n) {
    return '€ ' + n.toLocaleString('it-IT');
}

// dà ai materiali i colori scelti
function applicaScelta(materiali) {
    const m = opzione('montatura'), l = opzione('lenti'), c = opzione('cerniere');
    [materiali.frontale, materiali.aste].forEach(function(mat) {
        mat.color.set(m.colore);
        mat.roughness = m.ruvido;
        mat.clearcoat = m.laccato;
        mat.transparent = Boolean(m.opacita);
        mat.opacity = m.opacita || 1;
        mat.depthWrite = !m.opacita;
        mat.needsUpdate = true;
    });
    const lente = materiali.lenti;
    lente.color.set(l.colore);
    lente.metalness = l.metallo;
    lente.iridescence = l.iridescenza;
    lente.opacity = l.opacita;
    lente.needsUpdate = true;
    materiali.cerniere.color.set(c.colore);
}

// i campioni: uno per ogni opzione, in ogni gruppo
document.querySelectorAll('.m-scelta').forEach(function(blocco) {
    const gruppo = blocco.dataset.gruppo;
    const fila = blocco.querySelector('.m-campioni');
    const valore = blocco.querySelector('.m-scelta-valore');
    OPZIONI[gruppo].forEach(function(o) {
        const campione = document.createElement('button');
        campione.type = 'button';
        campione.className = 'm-campione' + (o.specchio ? ' specchio' : '') + (o.id === scelta[gruppo] ? ' selected' : '');
        campione.style.background = o.campione || o.colore;
        if (o.opacita && gruppo === 'montatura') campione.style.opacity = 0.75;
        campione.setAttribute('aria-label', o.nome);
        campione.title = o.nome;
        if (o.extra) campione.dataset.extra = '+' + o.extra;
        campione.addEventListener('click', function() {
            scelta[gruppo] = o.id;
            fila.querySelectorAll('.m-campione').forEach(function(c) { c.classList.remove('selected'); });
            campione.classList.add('selected');
            aggiornaShop();
        });
        fila.appendChild(campione);
    });
    valore.textContent = opzione(gruppo).nome;
});

function aggiornaShop() {
    document.querySelectorAll('.m-scelta').forEach(function(blocco) {
        blocco.querySelector('.m-scelta-valore').textContent = opzione(blocco.dataset.gruppo).nome;
    });
    document.getElementById('shop-prezzo').textContent = euro(prezzo(scelta));
    if (materialiPrincipali) applicaScelta(materialiPrincipali);   // gli occhiali 3D cambiano subito
}

// ===== LA BORSA =====
// resta salvata in questo browser (localStorage), ma non viene mandata da nessuna parte
let borsa = [];
try {
    borsa = JSON.parse(localStorage.getItem('morri-borsa')) || [];
} catch (e) {
    borsa = [];
}

function salvaBorsa() {
    try {
        localStorage.setItem('morri-borsa', JSON.stringify(borsa));
    } catch (e) { /* senza salvataggio la borsa vale solo per questa visita */ }
}

function disegnaBorsa() {
    const elenco = document.getElementById('borsa-elenco');
    elenco.innerHTML = '';
    let totale = 0;
    borsa.forEach(function(articolo, i) {
        const p = prezzo(articolo);
        totale += p;
        const voce = document.createElement('li');
        const colori = document.createElement('div');
        colori.className = 'm-borsa-colori';
        ['montatura', 'lenti', 'cerniere'].forEach(function(g) {
            const o = opzione(g, articolo[g]);
            const pallino = document.createElement('span');
            pallino.style.background = o.campione || o.colore;
            colori.appendChild(pallino);
        });
        const testo = document.createElement('div');
        testo.innerHTML = '<h3>Morri 01</h3><p></p><button type="button">Rimuovi</button>';
        testo.querySelector('p').textContent = opzione('montatura', articolo.montatura).nome + ' · lenti ' +
            opzione('lenti', articolo.lenti).nome.toLowerCase() + ' · cerniere ' + opzione('cerniere', articolo.cerniere).nome.toLowerCase();
        testo.querySelector('button').addEventListener('click', function() {
            borsa.splice(i, 1);
            salvaBorsa();
            disegnaBorsa();
        });
        const cifra = document.createElement('span');
        cifra.className = 'm-borsa-prezzo';
        cifra.textContent = euro(p);
        voce.appendChild(colori);
        voce.appendChild(testo);
        voce.appendChild(cifra);
        elenco.appendChild(voce);
    });
    document.getElementById('borsa-numero').textContent = borsa.length;
    document.getElementById('borsa-totale').textContent = euro(totale);
    document.getElementById('borsa-vuota').hidden = borsa.length > 0;
    document.getElementById('borsa-procedi').disabled = borsa.length === 0;
    document.getElementById('borsa-messaggio').hidden = true;
}

function apriBorsa(aperta) {
    document.body.classList.toggle('borsa-aperta', aperta);
    document.querySelector('.m-borsa').setAttribute('aria-hidden', !aperta);
}

document.querySelectorAll('.js-apri-borsa').forEach(function(b) {
    b.addEventListener('click', function() { apriBorsa(true); });
});
document.querySelectorAll('.js-chiudi-borsa').forEach(function(b) {
    b.addEventListener('click', function() { apriBorsa(false); });
});
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') apriBorsa(false);
});

const bottoneAggiungi = document.getElementById('shop-aggiungi');
bottoneAggiungi.addEventListener('click', function() {
    borsa.push(Object.assign({}, scelta));
    salvaBorsa();
    disegnaBorsa();
    // per un attimo il bottone dice "Aggiunto", poi si apre la borsa
    const testo = bottoneAggiungi.querySelector('span');
    testo.textContent = 'Aggiunto';
    bottoneAggiungi.classList.add('aggiunto');
    setTimeout(function() {
        testo.textContent = 'Aggiungi alla borsa';
        bottoneAggiungi.classList.remove('aggiunto');
        apriBorsa(true);
    }, 700);
});

document.getElementById('borsa-procedi').addEventListener('click', function() {
    document.getElementById('borsa-messaggio').hidden = false;
});

aggiornaShop();
disegnaBorsa();

// ===== PROVALI SU DI TE =====
document.querySelectorAll('.js-prova').forEach(function(bottone) {
    bottone.addEventListener('click', function() {
        apriProva({
            titolo: 'Morri',
            caricaModello: function() {
                return caricaModelloMorri().then(function(r) { return r.modello; });
            }
        });
    });
});

// ===== AVVIO =====
document.body.classList.add('m-in-caricamento');
const schermoCaricamento = document.querySelector('.m-caricamento');
const percentuale = document.getElementById('percentuale');

caricaModelloMorri(function(quanto) {
    const p = Math.min(99, Math.round(quanto * 100));
    percentuale.textContent = p;
    schermoCaricamento.style.setProperty('--avanzamento', p / 100);
}).then(function(r) {
    preparaModello(v, r.modello, r.pezzi);   // stanghette ed esploso (da meccanica.js)
    materialiPrincipali = r.materiali;
    applicaScelta(materialiPrincipali);
    fotografaViste();                        // le immagini della griglia (sotto lo schermo di caricamento)
    percentuale.textContent = '100';
    schermoCaricamento.style.setProperty('--avanzamento', 1);
    calcolaTappe();
    renderer.setAnimationLoop(fotogramma);

    // via lo schermo di caricamento: il marchio sale, gli occhiali compaiono
    setTimeout(function() {
        schermoCaricamento.classList.add('finito');
        document.body.classList.remove('m-in-caricamento');
        document.body.classList.add('m-pronto');
        setTimeout(function() { schermoCaricamento.remove(); }, 1100);
    }, 350);
}).catch(function(errore) {
    console.error('Morri: non è stato possibile caricare gli occhiali', errore);
    percentuale.parentNode.innerHTML = '<span style="font-size:0.2em">Apri il sito da un server (es. Live Server) per caricare il modello 3D.</span>';
});

// quando i caratteri sono pronti le sezioni cambiano altezza: ricalcoliamo le tappe
if (document.fonts && document.fonts.ready) document.fonts.ready.then(calcolaTappe);
