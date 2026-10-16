// FTC Used Car Rule Buyers Guide (16 CFR Part 455, as amended 81 FR 81664, Nov. 18, 2016).
// Fixed wording is transcribed from the Rule text (§§ 455.2, 455.5) and Figures 1–6 of Part 455
// (eCFR, current as of Oct. 2026). Do not edit, shorten or add to it: § 455.2(a)(2) requires the
// capitalization, punctuation and wording to be exactly as in the Rule.
// The website guide and the printed window guide both render from renderBuyersGuide(), so they always match.
import { html, raw } from './core.js';

export const BG = {
  en: {
    title: 'BUYERS GUIDE',
    important: html`<b>IMPORTANT:</b> Spoken promises are difficult to enforce. Ask the dealer to put all promises in writing. Keep this form.`,
    make: 'VEHICLE MAKE', model: 'MODEL', year: 'YEAR', vin: 'VEHICLE IDENTIFICATION NUMBER (VIN)',
    warranties: 'WARRANTIES FOR THIS VEHICLE:',
    asIs: 'AS IS - NO DEALER WARRANTY',
    asIsText: 'THE DEALER DOES NOT PROVIDE A WARRANTY FOR ANY REPAIRS AFTER SALE.',
    implied: 'IMPLIED WARRANTIES ONLY',
    impliedText: "The dealer doesn't make any promises to fix things that need repair when you buy the vehicle or afterward. But implied warranties under your state's laws may give you some rights to have the dealer take care of serious problems that were not apparent when you bought the vehicle.",
    dealerWarranty: 'DEALER WARRANTY',
    full: 'FULL WARRANTY.',
    limited: (labor, parts) => html`LIMITED WARRANTY. The dealer will pay ${blank(labor)}% of the labor and ${blank(parts)}% of the parts for the covered systems that fail during the warranty period. Ask the dealer for a copy of the warranty, and for any documents that explain warranty coverage, exclusions, and the dealer's repair obligations. <i>Implied warranties</i> under your state's laws may give you additional rights.`,
    systems: 'SYSTEMS COVERED:', duration: 'DURATION:',
    nonDealer: 'NON-DEALER WARRANTIES FOR THIS VEHICLE:',
    mfr: "MANUFACTURER'S WARRANTY STILL APPLIES. The manufacturer's original warranty has not expired on some components of the vehicle.",
    mfrUsed: "MANUFACTURER'S USED VEHICLE WARRANTY APPLIES.",
    otherUsed: 'OTHER USED VEHICLE WARRANTY APPLIES.',
    askCopy: 'Ask the dealer for a copy of the warranty document and an explanation of warranty coverage, exclusions, and repair obligations.',
    service: html`SERVICE CONTRACT. A service contract on this vehicle is available for an extra charge. Ask for details about coverage, deductible, price, and exclusions. If you buy a service contract within 90 days of your purchase of this vehicle, <i>implied warranties</i> under your state's laws may give you additional rights.`,
    inspect: 'ASK THE DEALER IF YOUR MECHANIC CAN INSPECT THE VEHICLE ON OR OFF THE LOT.',
    history: html`<b>OBTAIN A VEHICLE HISTORY REPORT AND CHECK FOR OPEN SAFETY RECALLS.</b> For information on how to obtain a vehicle history report, visit ftc.gov/usedcars. To check for open safety recalls, visit safercar.gov. You will need the vehicle identification number (VIN) shown above to make the best use of the resources on these sites.`,
    otherSide: html`<b>SEE OTHER SIDE</b> for important additional information, including a list of major defects that may occur in used motor vehicles.`,
    spanishNote: 'Si el concesionario gestiona la venta en español, pídale una copia de la Guía del Comprador en español.',
    defectsIntro: 'Here is a list of some major defects that may occur in used vehicles.',
    defects: [
      ['Frame & Body', ['Frame-cracks, corrective welds, or rusted through', 'Dog tracks—bent or twisted frame']],
      ['Engine', ['Oil leakage, excluding normal seepage', 'Cracked block or head', 'Belts missing or inoperable', 'Knocks or misses related to camshaft lifters and push rods', 'Abnormal exhaust discharge']],
      ['Transmission & Drive Shaft', ['Improper fluid level or leakage, excluding normal seepage', 'Cracked or damaged case which is visible', 'Abnormal noise or vibration caused by faulty transmission or drive shaft', 'Improper shifting or functioning in any gear', 'Manual clutch slips or chatters']],
      ['Differential', ['Improper fluid level or leakage, excluding normal seepage', 'Cracked or damaged housing which is visible', 'Abnormal noise or vibration caused by faulty differential']],
      ['Cooling System', ['Leakage including radiator', 'Improperly functioning water pump']],
      ['Electrical System', ['Battery leakage', 'Improperly functioning alternator, generator, battery, or starter']],
      ['Fuel System', ['Visible leakage']],
      ['Inoperable Accessories', ['Gauges or warning devices', 'Air conditioner', 'Heater & Defroster']],
      ['Brake System', ['Failure warning light broken', 'Pedal not firm under pressure (DOT spec.)', 'Not enough pedal reserve (DOT spec.)', 'Does not stop vehicle in straight line (DOT spec.)', 'Hoses damaged', 'Drum or rotor too thin (Mfgr. Specs)', 'Lining or pad thickness less than 1/32 inch', 'Power unit not operating or leaking', 'Structural or mechanical parts damaged']],
      ['Air Bags', []],
      ['Steering System', ['Too much free play at steering wheel (DOT specs.)', 'Free play in linkage more than 1/4 inch', 'Steering gear binds or jams', 'Front wheels aligned improperly (DOT specs.)', 'Power unit belts cracked or slipping', 'Power unit fluid level improper']],
      ['Suspension System', ['Ball joint seals damaged', 'Structural parts bent or damaged', 'Stabilizer bar disconnected', 'Spring broken', 'Shock absorber mounting loose', 'Rubber bushings damaged or missing', 'Radius rod damaged or missing', 'Shock absorber leaking or functioning improperly']],
      ['Tires', ['Tread depth less than 2/32 inch', 'Sizes mismatched', 'Visible damage']],
      ['Wheels', ['Visible cracks, damage or repairs', 'Mounting bolts loose or missing']],
      ['Exhaust System', ['Leakage', 'Catalytic Converter']],
    ],
    dealerName: 'DEALER NAME', address: 'ADDRESS', phone: 'TELEPHONE', email: 'EMAIL',
    complaints: 'FOR COMPLAINTS AFTER SALE, CONTACT:',
    signature: 'I hereby acknowledge receipt of the Buyers Guide at the closing of this sale.',
    importantBack: html`<b>IMPORTANT:</b> The information on this form is part of any contract to buy this vehicle. Removing this label before consumer purchase (except for purpose of test-driving) violates federal law (16 C.F.R. 455).`,
  },
  es: {
    title: 'GUÍA DEL COMPRADOR',
    important: html`<b>IMPORTANTE:</b> Las promesas verbales son difíciles de hacer cumplir. Solicite al concesionario que ponga todas las promesas por escrito. Conserve este formulario.`,
    make: 'MARCA DEL VEHÍCULO', model: 'MODELO', year: 'AÑO', vin: 'NÚMERO DE IDENTIFICACIÓN DEL VEHÍCULO (VIN)',
    warranties: 'GARANTÍAS PARA ESTE VEHÍCULO:',
    asIs: 'COMO ESTÁ - SIN GARANTÍA DEL CONCESIONARIO',
    asIsText: 'EL CONCESIONARIO NO PAGARÁ NINGUNA REPARACIÓN. El concesionario no provee una garantía para reparaciones hechas después del momento de la venta.',
    implied: 'SOLO GARANTÍAS IMPLÍCITAS',
    impliedText: 'El concesionario no hace ninguna promesa de reparar lo que sea necesario cuando compre el vehículo o posteriormente. Sin embargo, las garantías implícitas según las leyes estatales podrían darle algunos derechos para hacer que el concesionario se encargue de ciertos problemas que no fueran evidentes cuando compró el vehículo.',
    dealerWarranty: 'GARANTÍA DEL CONCESIONARIO',
    full: 'GARANTÍA COMPLETA.',
    limited: (labor, parts) => html`GARANTÍA LIMITADA. El concesionario pagará el ${blank(labor)}% de la mano de obra y el ${blank(parts)}% de las partes de los sistemas cubiertos que fallen durante el período de garantía. Pídale al concesionario una copia de la garantía y de cualquier documento que le explique la cobertura, las exclusiones y las obligaciones de reparación del concesionario. Las <i>garantías implícitas</i>, según las leyes de su estado, podrían darle derechos adicionales.`,
    systems: 'SISTEMAS CUBIERTOS:', duration: 'DURACIÓN:',
    nonDealer: 'GARANTÍAS QUE NO PERTENECEN AL CONCESIONARIO:',
    mfr: 'LA GARANTÍA DEL FABRICANTE TODAVÍA APLICA. La garantía original del fabricante no ha expirado para algunos de los componentes del vehículo.',
    mfrUsed: 'SE APLICA LA GARANTÍA DEL FABRICANTE PARA VEHÍCULOS USADOS.',
    otherUsed: 'SE APLICA OTRA GARANTÍA PARA VEHÍCULOS USADOS.',
    askCopy: 'Pídale al concesionario una copia del documento de garantía y una explicación de la cobertura, las exclusiones y las obligaciones de reparación.',
    service: html`CONTRATO DE MANTENIMIENTO. Con un cargo adicional, puede obtener un contrato de mantenimiento para este vehículo. Pregunte acerca de los detalles de la cobertura, los deducibles, el precio y las exclusiones. Si compra un contrato de mantenimiento dentro de los 90 días desde el momento en que compró el vehículo, las <i>garantías implícitas</i> según las leyes de su estado podrían darle derechos adicionales.`,
    inspect: 'PREGÚNTELE AL CONCESIONARIO SI SU MECÁNICO PUEDE INSPECCIONAR EL VEHÍCULO DENTRO O FUERA DEL CONCESIONARIO.',
    history: html`<b>OBTENGA UN INFORME DEL HISTORIAL DEL VEHÍCULO Y VERIFIQUE SI EXISTEN RETIROS POR DEFECTOS DE SEGURIDAD PENDIENTES.</b> Para información sobre cómo obtener un Informe del Historial del Vehículo, visite el sitio ftc.gov/carrosusados. Para verificar si existen retiros por defectos de seguridad pendientes, visite safercar.gov. Para aprovechar al máximo los recursos de estos sitios necesitará el número de identificación de vehículo (VIN) mostrado anteriormente.`,
    otherSide: html`<b>CONSULTE EL DORSO para obtener más información, incluyendo una lista de defectos importantes que pueden ocurrir en vehículos de motor usados.</b>`,
    spanishNote: null,
    defectsIntro: 'A continuación podrá encontrar una lista de los defectos principales que podrían ocurrir en vehículos usados.',
    defects: [
      ['Chasis y carrocería', ['Grietas en el chasis, soldaduras correctivas u oxidadas', 'Descuadrado: chasis doblado o torcido']],
      ['Motor', ['Pérdidas de aceite, excepto las filtraciones normales', 'Bloque o cárter con grietas', 'Correas ausentes o fuera de servicio', 'Golpes o fallas relacionados con levantadores de levas o bielas', 'Descarga del escape fuera de lo normal']],
      ['Transmisión y eje motor', ['Nivel inadecuado de fluido o pérdidas excepto filtraciones normales', 'Grietas o daños visibles en la caja.', 'Ruidos o vibraciones fuera de lo normal ocasionadas por la transmisión o el eje motor', 'Cambios o funcionamiento inadecuados en cualquier velocidad', 'Patinados o vibraciones del embrague manual']],
      ['Diferencial', ['Nivel inadecuado de fluido o pérdidas excepto filtraciones normales', 'Grietas o daños visibles en el cárter del diferencial', 'Ruidos o vibraciones fuera de lo normal ocasionadas por fallas en el diferencial.']],
      ['Sistema de enfriamiento', ['Pérdidas, incluidas las del radiador', 'Funcionamiento inadecuado de la bomba de agua']],
      ['Sistema eléctrico', ['Pérdidas en la batería', 'Funcionamiento inadecuado del alternador, generador, batería o arrancador']],
      ['Sistema de combustible', ['Pérdidas visibles']],
      ['Accesorios fuera de servicio', ['Indicadores o dispositivos de advertencia', 'Aire acondicionado', 'Calefacción y Desempañador']],
      ['Sistema de frenos', ['Luz de advertencia de fallas rota', 'Falta de firmeza cuando se presiona el pedal (según especificaciones del Departamento de Transporte [DOT])', 'Distancia insuficiente del pedal (según especificaciones del DOT)', 'El vehículo no se detiene en línea recta (según especificaciones del DOT)', 'Mangueras dañadas', 'Tambor o rotor muy delgados (según especificaciones del fabricante)', 'Grosor de la placa o del revestimiento inferior que 1/32 pulgadas', 'Unidad de potencia fuera de servicio o con pérdidas', 'Partes estructurales o mecánicas dañadas']],
      ['Bolsas de aire', []],
      ['Sistema de dirección', ['Demasiado juego en el volante (según especificaciones del DOT)', 'Juego mayor a 1/4 de pulgada en el varillaje.', 'El mecanismo de dirección se traba', 'Alineación inadecuada de las ruedas frontales (según especificaciones del DOT)', 'Grietas o deslizamientos en las correas de la unidad de potencia', 'Nivel inadecuado de fluidos de la unidad de potencia']],
      ['Sistema de suspensión', ['Juntas de rótula dañadas', 'Partes estructurales dobladas o dañadas', 'Barra estabilizadora desconectada', 'Resorte roto', 'Cojinete del amortiguador suelto', 'Cojinetes de caucho dañados o ausentes', 'Biela dañada o ausente', 'Amortiguador con pérdidas o con funcionamiento inadecuado']],
      ['Neumáticos', ['Profundidad de las ranuras menor que 2/32 de pulgada', 'Tamaños que no corresponden', 'Daños visibles']],
      ['Ruedas', ['Grietas, daños o reparaciones visibles', 'Tornillos de sujeción sueltos o ausentes']],
      ['Sistema de escape', ['Pérdidas', 'Convertidor catalítico']],
    ],
    dealerName: 'NOMBRE DEL CONCESIONARIO', address: 'DIRECCIÓN DEL CONCESIONARIO', phone: 'TELÉFONO', email: 'CORREO ELECTRÓNICO',
    complaints: 'PARA QUEJAS DESPUÉS DE LA VENTA COMUNÍQUESE CON:',
    signature: 'Por este medio confirmo que he recibido copia de la Guía del Comprador al momento de la compraventa.',
    importantBack: html`<b>IMPORTANTE:</b> La información de este formulario es parte de cualquier contrato para comprar este vehículo. Quitar esta etiqueta antes de la compra del consumidor (excepto a los fines de realizar una prueba de conducción) es una infracción a la ley federal (16 C. F. R. 455).`,
  },
};

function blank(v) { return v === null || v === undefined || v === '' ? raw('____') : raw(`<u>&nbsp;${Number(v)}&nbsp;</u>`); }

/** The Buyers Guide applies to used vehicles (16 CFR 455.1(d)(2)); certified pre-owned vehicles are used vehicles. */
export const needsBuyersGuide = (v) => v && v.condition !== 'new';

/** Shorthand banned by 16 CFR 455.2(b)(2)(ii). Mirrors vp_bg_shorthand() in the database. */
export const isShorthand = (t) => /(drive|power)[\s-]*train/i.test(String(t || ''));

/**
 * Which disclosure applies. Never invents coverage: vehicle terms first, then the dealership's stated
 * default, otherwise AS IS with pending=true (shown to staff only).
 */
export function resolveGuide(v, d = {}) {
  const status = v.bg_warranty || d.bg_default_warranty || 'as_is';
  const pending = !v.bg_warranty && !d.bg_default_warranty;
  const systems = Array.isArray(v.bg_systems) ? v.bg_systems.filter((s) => s && s.system) : [];
  return {
    status,
    pending,
    type: status === 'dealer_warranty' ? v.bg_warranty_type : null,
    labor: status === 'dealer_warranty' ? v.bg_labor_pct : null,
    parts: status === 'dealer_warranty' ? v.bg_parts_pct : null,
    deductible: status === 'dealer_warranty' ? v.bg_deductible : null,
    systems: status === 'dealer_warranty' ? systems : [],
    mfr: !!v.bg_mfr_warranty,
    mfrUsed: !!v.bg_mfr_used_warranty,
    otherUsed: !!v.bg_other_used_warranty,
    service: v.bg_warranty ? !!v.bg_service_contract : !!(v.bg_service_contract || d.bg_default_service_contract),
  };
}

/** Who handles complaints after sale. Until the dealer names someone, the dealership's own main line is used. */
export const complaintContact = (d) => (d.bg_complaint_name || d.bg_complaint_phone
  ? [d.bg_complaint_name, d.bg_complaint_phone].filter(Boolean).join(' · ')
  : [d.name, d.phone].filter(Boolean).join(' · '));

const box = (checked) => raw(`<span class="bg-box${checked ? ' on' : ''}" role="img" aria-label="${checked ? 'checked' : 'not checked'}">${checked ? '✕' : ''}</span>`);

/** Renders both sides of the Buyers Guide for vehicle v at dealership d. lang: 'en' | 'es'. */
export function renderBuyersGuide(v, d, lang = 'en', { signature = d.bg_signature_line } = {}) {
  const t = BG[lang] || BG.en;
  const g = resolveGuide(v, d);
  const addr = [d.address_line, [d.city, d.state].filter(Boolean).join(', '), d.zip].filter(Boolean).join(' ');
  const sameDuration = g.systems.length > 1 && g.systems.every((s) => s.duration === g.systems[0].duration);
  const noDealer = g.status !== 'dealer_warranty';

  const front = html`<div class="bg-side bg-front" lang="${lang}">
    <div class="bg-title">${t.title}</div>
    <p class="bg-important">${t.important}</p>
    <div class="bg-vehicle">
      <div><span class="bg-val">${v.make || ''}</span><span class="bg-lbl">${t.make}</span></div>
      <div><span class="bg-val">${v.model || ''}</span><span class="bg-lbl">${t.model}</span></div>
      <div><span class="bg-val">${v.year || ''}</span><span class="bg-lbl">${t.year}</span></div>
      <div class="bg-vin"><span class="bg-val">${v.vin || ''}</span><span class="bg-lbl">${t.vin}</span></div>
    </div>
    <div class="bg-h2">${t.warranties}</div>
    ${g.status === 'implied_only'
      ? html`<div class="bg-choice">${box(true)}<div><div class="bg-big">${t.implied}</div><p>${t.impliedText}</p></div></div>`
      : html`<div class="bg-choice">${box(g.status === 'as_is')}<div><div class="bg-big">${t.asIs}</div><p class="bg-caps">${t.asIsText}</p></div></div>`}
    <div class="bg-dash"></div>
    <div class="bg-choice">${box(!noDealer)}<div class="bg-big">${t.dealerWarranty}</div></div>
    <div class="bg-sub">${box(g.type === 'full')}<span>${t.full}</span></div>
    <div class="bg-sub">${box(g.type === 'limited')}<span>${t.limited(g.type === 'limited' ? g.labor : null, g.type === 'limited' ? g.parts : null)}</span></div>
    <div class="bg-systems">
      <div class="bg-cols"><b>${t.systems}</b><b>${t.duration}</b></div>
      ${g.systems.map((s, i) => html`<div class="bg-cols"><span>${s.system}</span><span>${sameDuration ? (i === 0 ? s.duration : '') : s.duration}</span></div>`)}
      ${g.deductible ? html`<div class="bg-fill">${g.deductible}</div>` : ''}
    </div>
    <div class="bg-h2">${t.nonDealer}</div>
    <div class="bg-sub">${box(g.mfr)}<span>${t.mfr}</span></div>
    <div class="bg-sub">${box(g.mfrUsed)}<span>${t.mfrUsed}</span></div>
    <div class="bg-sub">${box(g.otherUsed)}<span>${t.otherUsed}</span></div>
    <p class="bg-small">${t.askCopy}</p>
    ${g.service ? html`<div class="bg-rule"></div><div class="bg-sub">${box(true)}<span>${t.service}</span></div>` : ''}
    <div class="bg-rule thick"></div>
    <p class="bg-strong">${t.inspect}</p>
    <p class="bg-small">${t.history}</p>
    <p class="bg-small">${t.otherSide}</p>
    ${t.spanishNote ? html`<p class="bg-small"><b>${t.spanishNote}</b></p>` : ''}
  </div>`;

  const back = html`<div class="bg-side bg-back" lang="${lang}">
    <div class="bg-rule thick"></div>
    <p class="bg-small">${t.defectsIntro}</p>
    <div class="bg-defects">${t.defects.map(([h, items]) => html`<div class="bg-defect"><b>${h}</b>${items.map((i) => html`<span>${i}</span>`)}</div>`)}</div>
    <div class="bg-rule thick"></div>
    <div class="bg-line"><span class="bg-val">${d.name || ''}</span><span class="bg-lbl">${t.dealerName}</span></div>
    <div class="bg-line"><span class="bg-val">${addr}</span><span class="bg-lbl">${t.address}</span></div>
    <div class="bg-line bg-two"><div><span class="bg-val">${d.phone || ''}</span><span class="bg-lbl">${t.phone}</span></div><div><span class="bg-val">${d.email || ''}</span><span class="bg-lbl">${t.email}</span></div></div>
    <div class="bg-line"><span class="bg-val">${complaintContact(d)}</span><span class="bg-lbl">${t.complaints}</span></div>
    ${signature ? html`<div class="bg-line bg-sign"><span class="bg-val">&nbsp;</span><span class="bg-lbl">${t.signature}</span></div>` : ''}
    <div class="bg-rule thick"></div>
    <p class="bg-small">${t.importantBack}</p>
  </div>`;

  return { front, back, guide: g };
}
