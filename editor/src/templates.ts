/**
 * Starter templates for the editor's frictionless start.
 *
 * Each template seeds the editor's HTML / CSS / variables so a streamer can pick
 * one and personalize it, instead of starting from a blank canvas. They use the
 * same html + css + variables model the editor already renders (class-based CSS,
 * CSS @keyframes for animation, and {{nested.vars}} interpolated at render time).
 */
import { designComponents } from './design/components';

export interface EditorTemplate {
  id: string;
  name: string;
  description: string;
  html: string;
  css: string;
  /** Variables as a JSON string (the editor's Variables tab format). */
  variables: string;
}

export interface TemplateCategory {
  id: string;
  name: string;
  templates: EditorTemplate[];
}

const followAlert: EditorTemplate = {
  id: 'follow-alert',
  name: 'Follow Alert',
  description: 'Entrada deslizante + nombre del seguidor',
  html: `<div class="alert">
  <div class="alert-icon">★</div>
  <div class="alert-body">
    <div class="alert-title">¡Nuevo seguidor!</div>
    <div class="alert-name">{{follower.name}}</div>
  </div>
</div>`,
  css: `.alert {
  display: flex;
  align-items: center;
  gap: 16px;
  width: max-content;
  margin: 2em auto;
  padding: 18px 28px;
  border-radius: 14px;
  background: linear-gradient(135deg, #6d28d9, #9333ea);
  color: #fff;
  font-family: system-ui, sans-serif;
  animation: slideInLeft .6s ease-out both;
}
.alert-icon { font-size: 2.4em; line-height: 1; }
.alert-title { font-size: .9em; opacity: .85; text-transform: uppercase; letter-spacing: .06em; }
.alert-name { font-size: 1.8em; font-weight: 700; }

@keyframes slideInLeft {
  from { opacity: 0; transform: translateX(-48px); }
  to { opacity: 1; transform: translateX(0); }
}`,
  variables: `{
  "follower": {
    "name": "NuevoSeguidor123"
  }
}`,
};

const donationAlert: EditorTemplate = {
  id: 'donation-alert',
  name: 'Donation Alert',
  description: 'Zoom de entrada + monto y mensaje',
  html: `<div class="don">
  <div class="don-amount">\${{donation.amount}}</div>
  <div class="don-from">de {{donation.name}}</div>
  <div class="don-msg">{{donation.message}}</div>
</div>`,
  css: `.don {
  width: max-content;
  max-width: 18em;
  margin: 2em auto;
  padding: 20px 30px;
  border-radius: 14px;
  text-align: center;
  background: #0f172a;
  border: 2px solid #38bdf8;
  color: #fff;
  font-family: system-ui, sans-serif;
  animation: zoomIn .5s ease-out both;
}
.don-amount { font-size: 2.4em; font-weight: 800; color: #38bdf8; }
.don-from { font-size: 1em; opacity: .8; margin-top: 4px; }
.don-msg { font-size: 1.1em; margin-top: 10px; }

@keyframes zoomIn {
  from { opacity: 0; transform: scale(.6); }
  to { opacity: 1; transform: scale(1); }
}`,
  variables: `{
  "donation": {
    "amount": "25.00",
    "name": "ViewerGeneroso",
    "message": "¡Gracias por el stream!"
  }
}`,
};

const lowerThird: EditorTemplate = {
  id: 'lower-third',
  name: 'Lower Third',
  description: 'Nombre y rol con barra de acento',
  html: `<div class="lt">
  <div class="lt-bar"></div>
  <div class="lt-text">
    <div class="lt-name">{{user.name}}</div>
    <div class="lt-role">{{user.role}}</div>
  </div>
</div>`,
  css: `.lt {
  display: flex;
  align-items: stretch;
  gap: 14px;
  width: max-content;
  margin: 14em 0 0 4em;
  padding: 12px 22px 12px 12px;
  border-radius: 8px;
  background: rgba(15, 23, 42, .92);
  color: #fff;
  font-family: system-ui, sans-serif;
  animation: slideUp .5s ease-out both;
}
.lt-bar { width: 6px; border-radius: 3px; background: #22d3ee; }
.lt-name { font-size: 1.6em; font-weight: 700; }
.lt-role { font-size: 1em; opacity: .8; }

@keyframes slideUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}`,
  variables: `{
  "user": {
    "name": "Frederic Colins",
    "role": "Game Developer"
  }
}`,
};

const countdown: EditorTemplate = {
  id: 'countdown',
  name: 'Countdown',
  description: 'Cuenta regresiva que descuenta sola (mm:ss)',
  html: `<div class="cd">
  <div class="cd-label">{{countdown.label}}</div>
  <div class="cd-time" data-countdown="300">{{countdown.time}}</div>
</div>`,
  css: `.cd {
  width: max-content;
  margin: 2em auto;
  padding: 24px 40px;
  border-radius: 16px;
  text-align: center;
  background: #111827;
  color: #fff;
  font-family: system-ui, sans-serif;
}
.cd-label { font-size: 1em; text-transform: uppercase; letter-spacing: .1em; opacity: .7; }
.cd-time { font-size: 4em; font-weight: 800; font-variant-numeric: tabular-nums; }`,
  variables: `{
  "countdown": {
    "label": "Empezamos en",
    "time": "05:00"
  }
}`,
};

const subGoalBar: EditorTemplate = {
  id: 'sub-goal-bar',
  name: 'Sub Goal Bar',
  description: 'Barra de progreso de meta de subs',
  html: `<div class="goal">
  <div class="goal-label">Meta de Subs: {{goal.current}} / {{goal.target}}</div>
  <div class="goal-track"><div class="goal-fill"></div></div>
</div>`,
  css: `.goal {
  width: 24em;
  margin: 2em auto;
  padding: 16px 20px;
  border-radius: 12px;
  background: #1f2937;
  color: #fff;
  font-family: system-ui, sans-serif;
}
.goal-label { font-size: 1em; margin-bottom: 10px; }
.goal-track { height: 14px; border-radius: 999px; background: #374151; overflow: hidden; }
/* Edit the fill width to reflect your real progress (or wire it to a variable). */
.goal-fill { height: 100%; width: 65%; border-radius: 999px; background: linear-gradient(90deg, #34d399, #10b981); }`,
  variables: `{
  "goal": {
    "current": "65",
    "target": "100"
  }
}`,
};

const relojEnVivo: EditorTemplate = {
  id: "reloj-en-vivo",
  name: "Reloj en Vivo",
  description: "Chip de reloj elegante anclado arriba a la derecha que muestra la hora local en tiempo real (HH:MM:SS), actualizada cada segundo por el renderizador.",
  html: "<div class=\"clock\">\n  <div class=\"clock-icon\">\n    <span class=\"clock-dot\"></span>\n  </div>\n  <div class=\"clock-body\">\n    <div class=\"clock-time\" data-clock>00:00:00</div>\n    <div class=\"clock-label\">HORA LOCAL</div>\n  </div>\n</div>",
  css: ".clock {\n  position: absolute;\n  top: 32px;\n  right: 32px;\n  display: flex;\n  align-items: center;\n  gap: 14px;\n  padding: 14px 22px 14px 18px;\n  border-radius: 16px;\n  background: linear-gradient(135deg, rgba(17, 19, 28, 0.82), rgba(28, 22, 46, 0.82));\n  border: 1px solid rgba(34, 211, 238, 0.25);\n  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.06);\n  backdrop-filter: blur(8px);\n  font-family: system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif;\n}\n\n.clock-icon {\n  position: relative;\n  width: 34px;\n  height: 34px;\n  border-radius: 50%;\n  background: radial-gradient(circle at 30% 30%, rgba(147, 51, 234, 0.35), rgba(17, 19, 28, 0.2));\n  border: 2px solid rgba(34, 211, 238, 0.55);\n  box-shadow: 0 0 14px rgba(34, 211, 238, 0.35);\n  flex-shrink: 0;\n}\n\n.clock-dot {\n  position: absolute;\n  top: 50%;\n  left: 50%;\n  width: 7px;\n  height: 7px;\n  margin: -3.5px 0 0 -3.5px;\n  border-radius: 50%;\n  background: #22d3ee;\n  box-shadow: 0 0 10px rgba(34, 211, 238, 0.9);\n  animation: clock-pulse 1s ease-in-out infinite;\n}\n\n.clock-body {\n  display: flex;\n  flex-direction: column;\n  line-height: 1;\n}\n\n.clock-time {\n  font-size: 34px;\n  font-weight: 700;\n  letter-spacing: 2px;\n  color: #f4f6ff;\n  font-variant-numeric: tabular-nums;\n  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.7), 0 0 18px rgba(34, 211, 238, 0.25);\n}\n\n.clock-label {\n  margin-top: 6px;\n  font-size: 11px;\n  font-weight: 600;\n  letter-spacing: 4px;\n  color: rgba(180, 196, 255, 0.7);\n  text-transform: uppercase;\n  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);\n}\n\n@keyframes clock-pulse {\n  0%, 100% {\n    transform: scale(1);\n    opacity: 1;\n  }\n  50% {\n    transform: scale(1.6);\n    opacity: 0.45;\n  }\n}",
  variables: "{}",
};

const logoEsquinaGiratorio: EditorTemplate = {
  id: "logo-esquina-giratorio",
  name: "Logo en esquina giratorio",
  description: "Insignia circular con monograma fijada en la esquina superior derecha que permanece quieta y gira 360 grados periodicamente.",
  html: "<div class=\"cornerlogo\">\n  <div class=\"cornerlogo__spinner\">\n    <div class=\"cornerlogo__badge\">\n      <span class=\"cornerlogo__ring\"></span>\n      <span class=\"cornerlogo__shine\"></span>\n      <span class=\"cornerlogo__initials\">{{brand.initials}}</span>\n    </div>\n  </div>\n</div>",
  css: ".cornerlogo {\n  position: absolute;\n  top: 40px;\n  right: 40px;\n  width: 120px;\n  height: 120px;\n  font-family: system-ui, -apple-system, \"Segoe UI\", sans-serif;\n}\n\n.cornerlogo__spinner {\n  width: 100%;\n  height: 100%;\n  transform: rotate(0deg);\n  transform-origin: 50% 50%;\n  animation: cornerlogo-spin 8s cubic-bezier(0.65, 0, 0.35, 1) infinite;\n  will-change: transform;\n}\n\n.cornerlogo__badge {\n  position: relative;\n  width: 100%;\n  height: 100%;\n  border-radius: 50%;\n  background: linear-gradient(135deg, #9333ea 0%, #6d28d9 45%, #22d3ee 100%);\n  box-shadow:\n    0 10px 28px rgba(0, 0, 0, 0.55),\n    0 0 0 4px rgba(255, 255, 255, 0.08),\n    inset 0 2px 6px rgba(255, 255, 255, 0.35),\n    inset 0 -8px 18px rgba(0, 0, 0, 0.35);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  overflow: hidden;\n}\n\n.cornerlogo__ring {\n  position: absolute;\n  inset: 9px;\n  border-radius: 50%;\n  border: 2px solid rgba(255, 255, 255, 0.55);\n  box-shadow: inset 0 0 14px rgba(34, 211, 238, 0.45);\n  pointer-events: none;\n}\n\n.cornerlogo__shine {\n  position: absolute;\n  top: -30%;\n  left: -10%;\n  width: 70%;\n  height: 70%;\n  border-radius: 50%;\n  background: radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.65), rgba(255, 255, 255, 0) 70%);\n  pointer-events: none;\n}\n\n.cornerlogo__initials {\n  position: relative;\n  font-size: 46px;\n  font-weight: 800;\n  letter-spacing: 1px;\n  color: #ffffff;\n  text-shadow:\n    0 2px 4px rgba(0, 0, 0, 0.5),\n    0 0 12px rgba(34, 211, 238, 0.4);\n  z-index: 1;\n}\n\n@keyframes cornerlogo-spin {\n  0% {\n    transform: rotate(0deg);\n  }\n  78% {\n    transform: rotate(0deg);\n  }\n  100% {\n    transform: rotate(360deg);\n  }\n}",
  variables: "{\"brand\":{\"initials\":\"DP\"}}",
};

const weatherChipTopLeft: EditorTemplate = {
  id: "weather-chip-top-left",
  name: "Estado del Tiempo",
  description: "Chip compacto de clima en la esquina superior izquierda con icono, temperatura, condicion y ciudad.",
  html: "<div class=\"wx\">\n  <div class=\"wx-icon\">⛅</div>\n  <div class=\"wx-body\">\n    <div class=\"wx-temp\">{{weather.temp}}</div>\n    <div class=\"wx-meta\">\n      <span class=\"wx-cond\">{{weather.condition}}</span>\n      <span class=\"wx-city\">{{weather.city}}</span>\n    </div>\n  </div>\n</div>",
  css: ".wx {\n  position: absolute;\n  top: 32px;\n  left: 32px;\n  display: flex;\n  align-items: center;\n  gap: 14px;\n  padding: 12px 20px 12px 14px;\n  background: linear-gradient(135deg, rgba(17, 18, 30, 0.82), rgba(30, 18, 48, 0.82));\n  border: 1px solid rgba(34, 211, 238, 0.28);\n  border-radius: 18px;\n  backdrop-filter: blur(8px);\n  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.06);\n  font-family: system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif;\n  color: #f4f6ff;\n  animation: wx-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;\n}\n\n.wx-icon {\n  font-size: 38px;\n  line-height: 1;\n  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.5));\n  animation: wx-float 3.2s ease-in-out infinite;\n}\n\n.wx-body {\n  display: flex;\n  align-items: baseline;\n  gap: 14px;\n}\n\n.wx-temp {\n  font-size: 34px;\n  font-weight: 800;\n  line-height: 1;\n  letter-spacing: -0.5px;\n  background: linear-gradient(180deg, #ffffff, #cfe9ff);\n  -webkit-background-clip: text;\n  background-clip: text;\n  color: transparent;\n  text-shadow: 0 1px 8px rgba(34, 211, 238, 0.25);\n}\n\n.wx-meta {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.wx-cond {\n  font-size: 15px;\n  font-weight: 600;\n  color: #e6ecff;\n  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);\n}\n\n.wx-city {\n  font-size: 12px;\n  font-weight: 700;\n  letter-spacing: 1.2px;\n  text-transform: uppercase;\n  color: #22d3ee;\n  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);\n}\n\n@keyframes wx-in {\n  from { opacity: 0; transform: translateX(-24px); }\n  to   { opacity: 1; transform: translateX(0); }\n}\n\n@keyframes wx-float {\n  0%, 100% { transform: translateY(0); }\n  50%      { transform: translateY(-4px); }\n}",
  variables: "{\"weather\":{\"temp\":\"21°\",\"condition\":\"Parcialmente nublado\",\"city\":\"Madrid\"}}",
};

const statsDelStreamPills: EditorTemplate = {
  id: "stats-del-stream-pills",
  name: "Stats del Stream",
  description: "Fila de pildoras de estadisticas (espectadores, seguidores y subs) ubicada en la esquina inferior izquierda del overlay.",
  html: "<div class=\"sds\">\n  <div class=\"sds__pill sds__pill--viewers\">\n    <span class=\"sds__icon\">&#128065;</span>\n    <span class=\"sds__body\">\n      <span class=\"sds__label\">Espectadores</span>\n      <span class=\"sds__value\">{{stats.viewers}}</span>\n    </span>\n    <span class=\"sds__live\">\n      <span class=\"sds__dot\"></span>EN VIVO\n    </span>\n  </div>\n  <div class=\"sds__pill sds__pill--followers\">\n    <span class=\"sds__icon\">&#10084;</span>\n    <span class=\"sds__body\">\n      <span class=\"sds__label\">Seguidores</span>\n      <span class=\"sds__value\">{{stats.followers}}</span>\n    </span>\n  </div>\n  <div class=\"sds__pill sds__pill--subs\">\n    <span class=\"sds__icon\">&#9733;</span>\n    <span class=\"sds__body\">\n      <span class=\"sds__label\">Subs</span>\n      <span class=\"sds__value\">{{stats.subs}}</span>\n    </span>\n  </div>\n</div>",
  css: ".sds {\n  position: absolute;\n  left: 48px;\n  bottom: 48px;\n  display: flex;\n  gap: 16px;\n  align-items: stretch;\n  font-family: system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif;\n  z-index: 10;\n}\n\n.sds__pill {\n  display: flex;\n  align-items: center;\n  gap: 14px;\n  padding: 14px 22px 14px 16px;\n  border-radius: 18px;\n  background: linear-gradient(135deg, rgba(17, 18, 27, 0.92) 0%, rgba(30, 22, 48, 0.92) 100%);\n  border: 1px solid rgba(255, 255, 255, 0.08);\n  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.06);\n  backdrop-filter: blur(8px);\n  animation: sds-rise 0.6s cubic-bezier(0.22, 1, 0.36, 1) both;\n}\n\n.sds__pill--viewers { animation-delay: 0s; }\n.sds__pill--followers { animation-delay: 0.12s; }\n.sds__pill--subs { animation-delay: 0.24s; }\n\n.sds__icon {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 42px;\n  height: 42px;\n  border-radius: 12px;\n  font-size: 20px;\n  line-height: 1;\n  color: #fff;\n  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);\n  flex: 0 0 auto;\n}\n\n.sds__pill--viewers .sds__icon {\n  background: linear-gradient(135deg, #22d3ee 0%, #0ea5b7 100%);\n  box-shadow: 0 0 16px rgba(34, 211, 238, 0.5);\n}\n.sds__pill--followers .sds__icon {\n  background: linear-gradient(135deg, #f472b6 0%, #db2777 100%);\n  box-shadow: 0 0 16px rgba(244, 114, 182, 0.5);\n}\n.sds__pill--subs .sds__icon {\n  background: linear-gradient(135deg, #9333ea 0%, #6d28d9 100%);\n  box-shadow: 0 0 16px rgba(147, 51, 234, 0.5);\n}\n\n.sds__body {\n  display: flex;\n  flex-direction: column;\n  justify-content: center;\n  line-height: 1.1;\n}\n\n.sds__label {\n  font-size: 12px;\n  font-weight: 600;\n  letter-spacing: 0.08em;\n  text-transform: uppercase;\n  color: rgba(255, 255, 255, 0.55);\n}\n\n.sds__value {\n  font-size: 24px;\n  font-weight: 800;\n  color: #fff;\n  letter-spacing: 0.01em;\n  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);\n  font-variant-numeric: tabular-nums;\n}\n\n.sds__live {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  margin-left: 6px;\n  padding: 4px 10px;\n  border-radius: 999px;\n  background: rgba(239, 68, 68, 0.16);\n  border: 1px solid rgba(239, 68, 68, 0.4);\n  color: #fca5a5;\n  font-size: 11px;\n  font-weight: 800;\n  letter-spacing: 0.1em;\n}\n\n.sds__dot {\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  background: #ef4444;\n  box-shadow: 0 0 8px rgba(239, 68, 68, 0.9);\n  animation: sds-pulse 1.4s ease-in-out infinite;\n}\n\n@keyframes sds-rise {\n  from {\n    opacity: 0;\n    transform: translateY(18px) scale(0.96);\n  }\n  to {\n    opacity: 1;\n    transform: translateY(0) scale(1);\n  }\n}\n\n@keyframes sds-pulse {\n  0%, 100% {\n    opacity: 1;\n    transform: scale(1);\n  }\n  50% {\n    opacity: 0.4;\n    transform: scale(0.7);\n  }\n}",
  variables: "{\"stats\":{\"viewers\":\"1.248\",\"followers\":\"32.7K\",\"subs\":\"847\"}}",
};

const chatEnPantalla: EditorTemplate = {
  id: "chat-en-pantalla",
  name: "Chat en Pantalla",
  description: "Panel de chat semitransparente en la esquina inferior izquierda con cabecera y mensajes de la comunidad.",
  html: "<div class=\"chat\">\n  <div class=\"chat__header\">\n    <span class=\"chat__dot\"></span>\n    <span class=\"chat__title\">{{chat.title}}</span>\n  </div>\n  <div class=\"chat__body\">\n    <div class=\"chat__row\">\n      <span class=\"chat__user chat__user--purple\">NeonFox</span>\n      <span class=\"chat__msg\">eyy buenas a todos! recien llego al stream</span>\n    </div>\n    <div class=\"chat__row\">\n      <span class=\"chat__user chat__user--cyan\">pixel_warrior</span>\n      <span class=\"chat__msg\">esa jugada estuvo brutal jajaja</span>\n    </div>\n    <div class=\"chat__row\">\n      <span class=\"chat__user chat__user--gold\">DonaMaria</span>\n      <span class=\"chat__msg\">primera vez aqui y me encanta el setup</span>\n    </div>\n    <div class=\"chat__row chat__row--new\">\n      <span class=\"chat__user chat__user--green\">luca.dev</span>\n      <span class=\"chat__msg\">GG, vamos por la victoria! Lets goo</span>\n    </div>\n  </div>\n</div>",
  css: ".chat {\n  position: absolute;\n  bottom: 48px;\n  left: 48px;\n  width: 420px;\n  font-family: system-ui, -apple-system, \"Segoe UI\", sans-serif;\n  background: linear-gradient(180deg, rgba(17, 18, 28, 0.82) 0%, rgba(12, 12, 20, 0.88) 100%);\n  border: 1px solid rgba(147, 51, 234, 0.35);\n  border-radius: 16px;\n  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.06);\n  backdrop-filter: blur(8px);\n  overflow: hidden;\n}\n\n.chat__header {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 12px 18px;\n  background: linear-gradient(90deg, rgba(147, 51, 234, 0.5) 0%, rgba(34, 211, 238, 0.2) 100%);\n  border-bottom: 1px solid rgba(255, 255, 255, 0.08);\n}\n\n.chat__dot {\n  width: 10px;\n  height: 10px;\n  border-radius: 50%;\n  background: #22d3ee;\n  box-shadow: 0 0 10px #22d3ee, 0 0 4px #22d3ee;\n  animation: chat-pulse 1.8s ease-in-out infinite;\n}\n\n.chat__title {\n  font-size: 15px;\n  font-weight: 800;\n  letter-spacing: 2.5px;\n  color: #ffffff;\n  text-transform: uppercase;\n  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);\n}\n\n.chat__body {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  padding: 12px 14px 16px;\n}\n\n.chat__row {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: baseline;\n  gap: 7px;\n  padding: 7px 10px;\n  border-radius: 10px;\n  line-height: 1.35;\n  background: rgba(255, 255, 255, 0.025);\n}\n\n.chat__row--new {\n  background: rgba(147, 51, 234, 0.14);\n  animation: chat-slide-in 0.5s ease-out both;\n}\n\n.chat__user {\n  font-size: 15px;\n  font-weight: 700;\n  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);\n  white-space: nowrap;\n}\n\n.chat__user::after {\n  content: \":\";\n  color: rgba(255, 255, 255, 0.4);\n  margin-left: 1px;\n}\n\n.chat__user--purple { color: #c084fc; }\n.chat__user--cyan   { color: #22d3ee; }\n.chat__user--gold   { color: #fbbf24; }\n.chat__user--green  { color: #4ade80; }\n\n.chat__msg {\n  font-size: 14.5px;\n  font-weight: 500;\n  color: #e8eaf2;\n  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);\n  word-break: break-word;\n}\n\n@keyframes chat-pulse {\n  0%, 100% { opacity: 1; transform: scale(1); }\n  50% { opacity: 0.45; transform: scale(0.8); }\n}\n\n@keyframes chat-slide-in {\n  from { opacity: 0; transform: translateX(-22px); }\n  to { opacity: 1; transform: translateX(0); }\n}",
  variables: "{\"chat\": {\"title\": \"CHAT\"}}",
};

const scoreboardTopCenter: EditorTemplate = {
  id: "scoreboard-top-center",
  name: "Marcador Deportivo (Top-Center)",
  description: "Marcador fijado arriba al centro con equipo local y visitante, sus puntuaciones, separador y etiqueta de periodo/reloj. Acentos de color por equipo.",
  html: "<div class=\"sb\">\n  <div class=\"sb__board\">\n    <div class=\"sb__team sb__team--home\">\n      <span class=\"sb__bar sb__bar--home\"></span>\n      <span class=\"sb__name\">{{home.name}}</span>\n      <span class=\"sb__score\" data-motion-pop=\"home.score\">{{home.score}}</span>\n    </div>\n    <div class=\"sb__center\">\n      <span class=\"sb__sep\">VS</span>\n      <span class=\"sb__clock\">{{match.clock}}</span>\n    </div>\n    <div class=\"sb__team sb__team--away\">\n      <span class=\"sb__score\" data-motion-pop=\"away.score\">{{away.score}}</span>\n      <span class=\"sb__name\">{{away.name}}</span>\n      <span class=\"sb__bar sb__bar--away\"></span>\n    </div>\n  </div>\n</div>",
  css: ".sb{position:absolute;top:28px;left:50%;transform:translateX(-50%);font-family:var(--ds-font,system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif);animation:sb-drop var(--ds-dur-slow,.6s) var(--ds-ease-entrance,cubic-bezier(.16,1,.3,1)) both;animation-delay:calc(var(--ds-stagger,0ms) * var(--dsm-i,0))}.sb__board{display:flex;align-items:stretch;background:var(--ds-surface,linear-gradient(180deg,rgba(17,19,28,.94),rgba(10,11,17,.94)));border:1px solid var(--ds-border,rgba(255,255,255,.08));border-radius:var(--ds-radius,16px);box-shadow:var(--ds-shadow,0 12px 40px rgba(0,0,0,.55));overflow:hidden;backdrop-filter:blur(6px)}.sb__team{display:flex;align-items:center;gap:16px;padding:14px 22px;position:relative}.sb__team--home{padding-left:26px}.sb__team--away{padding-right:26px}.sb__bar{width:6px;align-self:stretch;border-radius:4px;box-shadow:0 0 14px currentColor}.sb__bar--home{background:var(--ds-accent-2,#9333ea);color:var(--ds-accent-2,#9333ea)}.sb__bar--away{background:var(--ds-accent,#22d3ee);color:var(--ds-accent,#22d3ee)}.sb__name{font-size:26px;font-weight:700;letter-spacing:.5px;color:var(--ds-text,#f4f5fa);text-shadow:0 2px 6px rgba(0,0,0,.6);text-transform:uppercase;white-space:nowrap}.sb__score{font-size:40px;font-weight:800;line-height:1;min-width:56px;text-align:center;padding:6px 12px;border-radius:calc(var(--ds-radius,16px) - 6px);background:var(--ds-surface-2,rgba(255,255,255,.05));color:var(--ds-text,#fff);text-shadow:0 2px 8px rgba(0,0,0,.7);font-variant-numeric:tabular-nums}.sb__team--home .sb__score{box-shadow:inset 0 0 0 1px var(--ds-accent-2,rgba(147,51,234,.45))}.sb__team--away .sb__score{box-shadow:inset 0 0 0 1px var(--ds-accent,rgba(34,211,238,.45))}.sb__center{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:10px 24px;background:var(--ds-surface-2,linear-gradient(180deg,rgba(147,51,234,.22),rgba(34,211,238,.22)));border-left:1px solid var(--ds-border,rgba(255,255,255,.08));border-right:1px solid var(--ds-border,rgba(255,255,255,.08))}.sb__sep{font-size:15px;font-weight:800;letter-spacing:2px;color:var(--ds-muted,rgba(255,255,255,.7))}.sb__clock{font-size:20px;font-weight:700;color:var(--ds-text,#fff);letter-spacing:1px;font-variant-numeric:tabular-nums;text-shadow:0 0 10px var(--ds-glow,rgba(34,211,238,.6));animation:sb-pulse 2s ease-in-out infinite}@keyframes sb-drop{from{opacity:0;transform:translateX(-50%) translateY(-24px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}@keyframes sb-pulse{0%,100%{opacity:1}50%{opacity:.55}}",
  variables: "{\"home\":{\"name\":\"Dragones\",\"score\":2},\"away\":{\"name\":\"Lobos\",\"score\":1},\"match\":{\"clock\":\"2T 67:14\"}}",
};

const webcamFrameCornerAccents: EditorTemplate = {
  id: "webcam-frame-corner-accents",
  name: "Marco de Webcam",
  description: "Marco decorativo para webcam fijado abajo a la derecha, con centro transparente, acentos en las esquinas y etiqueta de nombre.",
  html: "<div class=\"wcf\">\n  <div class=\"wcf__border\"></div>\n  <span class=\"wcf__corner wcf__corner--tl\"></span>\n  <span class=\"wcf__corner wcf__corner--tr\"></span>\n  <span class=\"wcf__corner wcf__corner--bl\"></span>\n  <span class=\"wcf__corner wcf__corner--br\"></span>\n  <div class=\"wcf__tag\">\n    <span class=\"wcf__dot\"></span>\n    <span class=\"wcf__label\">{{cam.label}}</span>\n  </div>\n</div>",
  css: ".wcf {\n  position: absolute;\n  bottom: 40px;\n  right: 40px;\n  width: 480px;\n  height: 270px;\n  box-sizing: border-box;\n  font-family: system-ui, -apple-system, \"Segoe UI\", sans-serif;\n  pointer-events: none;\n}\n/* Decorative border only - center stays fully transparent so the cam shows through */\n.wcf__border {\n  position: absolute;\n  inset: 0;\n  border: 3px solid rgba(34, 211, 238, 0.85);\n  border-radius: 16px;\n  box-shadow:\n    0 0 0 1px rgba(0, 0, 0, 0.4),\n    0 0 18px rgba(34, 211, 238, 0.45),\n    0 10px 30px rgba(0, 0, 0, 0.5);\n  background: transparent;\n}\n/* Corner accents */\n.wcf__corner {\n  position: absolute;\n  width: 34px;\n  height: 34px;\n  border: 4px solid #9333ea;\n  filter: drop-shadow(0 0 6px rgba(147, 51, 234, 0.7));\n}\n.wcf__corner--tl {\n  top: -3px;\n  left: -3px;\n  border-right: none;\n  border-bottom: none;\n  border-top-left-radius: 16px;\n}\n.wcf__corner--tr {\n  top: -3px;\n  right: -3px;\n  border-left: none;\n  border-bottom: none;\n  border-top-right-radius: 16px;\n}\n.wcf__corner--bl {\n  bottom: -3px;\n  left: -3px;\n  border-right: none;\n  border-top: none;\n  border-bottom-left-radius: 16px;\n}\n.wcf__corner--br {\n  bottom: -3px;\n  right: -3px;\n  border-left: none;\n  border-top: none;\n  border-bottom-right-radius: 16px;\n}\n/* Name-tag bar at the bottom */\n.wcf__tag {\n  position: absolute;\n  left: 50%;\n  bottom: -16px;\n  transform: translateX(-50%);\n  display: flex;\n  align-items: center;\n  gap: 9px;\n  padding: 7px 18px;\n  background: linear-gradient(135deg, rgba(17, 17, 24, 0.92), rgba(34, 12, 48, 0.92));\n  border: 1px solid rgba(34, 211, 238, 0.55);\n  border-radius: 999px;\n  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.55);\n}\n.wcf__dot {\n  width: 11px;\n  height: 11px;\n  border-radius: 50%;\n  background: #ef4444;\n  box-shadow: 0 0 8px rgba(239, 68, 68, 0.9);\n  animation: wcf-pulse 1.6s ease-in-out infinite;\n}\n.wcf__label {\n  color: #f5f5f7;\n  font-size: 15px;\n  font-weight: 700;\n  letter-spacing: 1.5px;\n  text-transform: uppercase;\n  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);\n}\n@keyframes wcf-pulse {\n  0%, 100% { transform: scale(1); opacity: 1; }\n  50% { transform: scale(0.6); opacity: 0.45; }\n}",
  variables: "{\"cam\":{\"label\":\"EN VIVO\"}}",
};

const nowPlayingMusicBar: EditorTemplate = {
  id: "now-playing-music-bar",
  name: "Now Playing (Musica)",
  description: "Barra \"now playing\" en la esquina inferior derecha con ecualizador animado, glifo musical, cancion y artista.",
  html: "<div class=\"nowp\">\n  <div class=\"nowp__icon\">\n    <span class=\"nowp__glyph\">&#9835;</span>\n  </div>\n  <div class=\"nowp__eq\" aria-hidden=\"true\">\n    <span class=\"nowp__bar nowp__bar--1\"></span>\n    <span class=\"nowp__bar nowp__bar--2\"></span>\n    <span class=\"nowp__bar nowp__bar--3\"></span>\n    <span class=\"nowp__bar nowp__bar--4\"></span>\n  </div>\n  <div class=\"nowp__info\">\n    <span class=\"nowp__label\">NOW PLAYING</span>\n    <span class=\"nowp__song\">{{music.song}}</span>\n    <span class=\"nowp__artist\">{{music.artist}}</span>\n  </div>\n</div>",
  css: ".nowp {\n  position: absolute;\n  right: 48px;\n  bottom: 48px;\n  display: flex;\n  align-items: center;\n  gap: 16px;\n  padding: 14px 22px 14px 14px;\n  border-radius: 16px;\n  background: linear-gradient(135deg, rgba(17, 16, 28, 0.92), rgba(28, 18, 48, 0.92));\n  border: 1px solid rgba(147, 51, 234, 0.4);\n  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(34, 211, 238, 0.08) inset;\n  font-family: system-ui, -apple-system, \"Segoe UI\", sans-serif;\n  color: #ffffff;\n  max-width: 460px;\n  animation: nowp-slide-in 0.6s cubic-bezier(0.22, 1, 0.36, 1) both;\n}\n\n.nowp__icon {\n  flex: 0 0 auto;\n  width: 52px;\n  height: 52px;\n  border-radius: 12px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: linear-gradient(135deg, #9333ea, #22d3ee);\n  box-shadow: 0 6px 16px rgba(147, 51, 234, 0.45);\n}\n\n.nowp__glyph {\n  font-size: 28px;\n  line-height: 1;\n  color: #ffffff;\n  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);\n  animation: nowp-bob 2.4s ease-in-out infinite;\n}\n\n.nowp__eq {\n  flex: 0 0 auto;\n  display: flex;\n  align-items: flex-end;\n  gap: 4px;\n  height: 34px;\n  padding: 0 2px;\n}\n\n.nowp__bar {\n  width: 5px;\n  border-radius: 3px;\n  background: linear-gradient(to top, #9333ea, #22d3ee);\n  transform-origin: bottom center;\n}\n\n.nowp__bar--1 { height: 30%; animation: nowp-eq 0.9s ease-in-out infinite; }\n.nowp__bar--2 { height: 70%; animation: nowp-eq 0.7s ease-in-out infinite 0.15s; }\n.nowp__bar--3 { height: 45%; animation: nowp-eq 1.05s ease-in-out infinite 0.3s; }\n.nowp__bar--4 { height: 85%; animation: nowp-eq 0.8s ease-in-out infinite 0.45s; }\n\n.nowp__info {\n  display: flex;\n  flex-direction: column;\n  min-width: 0;\n  gap: 2px;\n}\n\n.nowp__label {\n  font-size: 11px;\n  font-weight: 700;\n  letter-spacing: 2px;\n  color: #22d3ee;\n  text-transform: uppercase;\n  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);\n}\n\n.nowp__song {\n  font-size: 19px;\n  font-weight: 700;\n  line-height: 1.2;\n  color: #ffffff;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.7);\n}\n\n.nowp__artist {\n  font-size: 14px;\n  font-weight: 500;\n  line-height: 1.2;\n  color: rgba(255, 255, 255, 0.72);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);\n}\n\n@keyframes nowp-eq {\n  0%, 100% { transform: scaleY(0.35); }\n  50% { transform: scaleY(1); }\n}\n\n@keyframes nowp-bob {\n  0%, 100% { transform: translateY(0) rotate(0deg); }\n  50% { transform: translateY(-3px) rotate(-6deg); }\n}\n\n@keyframes nowp-slide-in {\n  from { opacity: 0; transform: translateX(40px); }\n  to { opacity: 1; transform: translateX(0); }\n}",
  variables: "{\"music\":{\"song\":\"Midnight City\",\"artist\":\"M83\"}}",
};

const socialMediaBar: EditorTemplate = {
  id: "social-media-bar",
  name: "Barra de Redes Sociales",
  description: "Barra delgada anclada en la parte inferior central con los handles de Twitch, YouTube y X, cada uno con su glifo.",
  html: "<div class=\"smb\">\n  <div class=\"smb__bar\">\n    <div class=\"smb__item smb__item--twitch\">\n      <span class=\"smb__glyph\" aria-hidden=\"true\">\n        <svg viewBox=\"0 0 24 24\" class=\"smb__svg\"><path d=\"M4 3 3 6v13h4v2h3l2-2h3l4-4V3H4Zm15 11-2 2h-4l-2 2v-2H7V5h12v9Z\"/><path d=\"M14 8h2v4h-2zM10 8h2v4h-2z\"/></svg>\n      </span>\n      <span class=\"smb__text\">{{social.twitch}}</span>\n    </div>\n    <span class=\"smb__sep\" aria-hidden=\"true\"></span>\n    <div class=\"smb__item smb__item--youtube\">\n      <span class=\"smb__glyph\" aria-hidden=\"true\">\n        <svg viewBox=\"0 0 24 24\" class=\"smb__svg\"><path d=\"M22.5 7.2a3 3 0 0 0-2.1-2.1C18.6 4.6 12 4.6 12 4.6s-6.6 0-8.4.5A3 3 0 0 0 1.5 7.2 31 31 0 0 0 1 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.8.5 8.4.5 8.4.5s6.6 0 8.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 23 12a31 31 0 0 0-.5-4.8ZM9.8 15.3V8.7l5.7 3.3-5.7 3.3Z\"/></svg>\n      </span>\n      <span class=\"smb__text\">{{social.youtube}}</span>\n    </div>\n    <span class=\"smb__sep\" aria-hidden=\"true\"></span>\n    <div class=\"smb__item smb__item--x\">\n      <span class=\"smb__glyph\" aria-hidden=\"true\">\n        <svg viewBox=\"0 0 24 24\" class=\"smb__svg\"><path d=\"M17.5 3h3l-7 8 8.2 10h-6.4l-5-6.1L8 21H5l7.4-8.5L4.5 3H11l4.5 5.5L17.5 3Zm-1 16h1.7L7.6 4.8H5.8L16.5 19Z\"/></svg>\n      </span>\n      <span class=\"smb__text\">{{social.x}}</span>\n    </div>\n  </div>\n</div>",
  css: ".smb {\n  position: absolute;\n  left: 50%;\n  bottom: 36px;\n  transform: translateX(-50%);\n  font-family: system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif;\n  animation: smb-rise 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;\n}\n\n.smb__bar {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  padding: 10px 22px;\n  border-radius: 999px;\n  background: linear-gradient(180deg, rgba(20, 18, 33, 0.86) 0%, rgba(12, 11, 22, 0.92) 100%);\n  border: 1px solid rgba(147, 51, 234, 0.35);\n  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(34, 211, 238, 0.08) inset;\n  backdrop-filter: blur(8px);\n}\n\n.smb__item {\n  display: flex;\n  align-items: center;\n  gap: 9px;\n  padding: 4px 8px;\n}\n\n.smb__glyph {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 30px;\n  height: 30px;\n  border-radius: 50%;\n  background: rgba(255, 255, 255, 0.06);\n  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08) inset;\n  transition: transform 0.3s ease;\n}\n\n.smb__svg {\n  width: 18px;\n  height: 18px;\n  fill: #f3f0ff;\n  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.5));\n}\n\n.smb__item--twitch .smb__glyph { background: rgba(145, 70, 255, 0.22); }\n.smb__item--twitch .smb__svg { fill: #c4a7ff; }\n\n.smb__item--youtube .smb__glyph { background: rgba(255, 0, 0, 0.18); }\n.smb__item--youtube .smb__svg { fill: #ff7a7a; }\n\n.smb__item--x .smb__glyph { background: rgba(34, 211, 238, 0.14); }\n.smb__item--x .smb__svg { fill: #eafcff; }\n\n.smb__text {\n  font-size: 19px;\n  font-weight: 600;\n  letter-spacing: 0.2px;\n  color: #f5f3ff;\n  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75);\n  white-space: nowrap;\n}\n\n.smb__sep {\n  width: 1px;\n  height: 22px;\n  background: linear-gradient(180deg, transparent, rgba(255, 255, 255, 0.28), transparent);\n}\n\n.smb__item:hover .smb__glyph,\n.smb__item .smb__glyph { animation: smb-glow 3.6s ease-in-out infinite; }\n\n.smb__item--youtube .smb__glyph { animation-delay: 1.2s; }\n.smb__item--x .smb__glyph { animation-delay: 2.4s; }\n\n@keyframes smb-rise {\n  from { opacity: 0; transform: translate(-50%, 24px); }\n  to { opacity: 1; transform: translate(-50%, 0); }\n}\n\n@keyframes smb-glow {\n  0%, 100% { transform: scale(1); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08) inset; }\n  50% { transform: scale(1.08); box-shadow: 0 0 12px rgba(147, 51, 234, 0.45), 0 0 0 1px rgba(34, 211, 238, 0.25) inset; }\n}",
  variables: "{\"social\":{\"twitch\":\"twitch.tv/teamx\",\"youtube\":\"@TeamX\",\"x\":\"@teamx_live\"}}",
};

const pantallaEmpezamosPronto: EditorTemplate = {
  id: "pantalla-empezamos-pronto",
  name: "Pantalla Empezamos Pronto",
  description: "Escena a pantalla completa con fondo oscuro, titulo grande \"EMPEZAMOS PRONTO\", subtitulo y puntos animados pulsantes.",
  html: "<div class=\"brb\">\n  <div class=\"brb__glow\"></div>\n  <div class=\"brb__panel\">\n    <div class=\"brb__badge\">EN BREVE</div>\n    <h1 class=\"brb__title\">{{screen.title}}</h1>\n    <p class=\"brb__subtitle\">{{screen.subtitle}}</p>\n    <div class=\"brb__dots\">\n      <span class=\"brb__dot\"></span>\n      <span class=\"brb__dot\"></span>\n      <span class=\"brb__dot\"></span>\n    </div>\n  </div>\n</div>",
  css: ".brb {\n  position: absolute;\n  top: 0;\n  left: 0;\n  width: 1920px;\n  height: 1080px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: radial-gradient(ellipse at center, rgba(20, 8, 40, 0.82) 0%, rgba(6, 6, 12, 0.94) 70%, rgba(2, 2, 6, 0.97) 100%);\n  font-family: system-ui, -apple-system, \"Segoe UI\", sans-serif;\n  overflow: hidden;\n}\n\n.brb__glow {\n  position: absolute;\n  top: 50%;\n  left: 50%;\n  width: 1100px;\n  height: 1100px;\n  transform: translate(-50%, -50%);\n  background: radial-gradient(circle, rgba(147, 51, 234, 0.28) 0%, rgba(34, 211, 238, 0.12) 40%, transparent 68%);\n  filter: blur(40px);\n  animation: brb-breathe 6s ease-in-out infinite;\n  pointer-events: none;\n}\n\n.brb__panel {\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  text-align: center;\n  padding: 0 80px;\n  animation: brb-rise 1s cubic-bezier(0.22, 1, 0.36, 1) both;\n}\n\n.brb__badge {\n  display: inline-block;\n  padding: 12px 30px;\n  margin-bottom: 38px;\n  font-size: 26px;\n  font-weight: 700;\n  letter-spacing: 7px;\n  color: #e9d5ff;\n  background: linear-gradient(135deg, rgba(147, 51, 234, 0.35), rgba(34, 211, 238, 0.25));\n  border: 1.5px solid rgba(147, 51, 234, 0.55);\n  border-radius: 999px;\n  text-transform: uppercase;\n  box-shadow: 0 0 24px rgba(147, 51, 234, 0.4);\n  backdrop-filter: blur(6px);\n}\n\n.brb__title {\n  margin: 0;\n  font-size: 132px;\n  font-weight: 900;\n  line-height: 1.02;\n  letter-spacing: 2px;\n  text-transform: uppercase;\n  background: linear-gradient(180deg, #ffffff 0%, #d8b4fe 55%, #a855f7 100%);\n  -webkit-background-clip: text;\n  background-clip: text;\n  -webkit-text-fill-color: transparent;\n  color: #ffffff;\n  filter: drop-shadow(0 6px 30px rgba(147, 51, 234, 0.6));\n}\n\n.brb__subtitle {\n  margin: 28px 0 0;\n  font-size: 38px;\n  font-weight: 500;\n  letter-spacing: 1px;\n  color: rgba(226, 232, 240, 0.85);\n  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.8);\n}\n\n.brb__dots {\n  display: flex;\n  gap: 22px;\n  margin-top: 60px;\n}\n\n.brb__dot {\n  width: 22px;\n  height: 22px;\n  border-radius: 50%;\n  background: linear-gradient(135deg, #22d3ee, #9333ea);\n  box-shadow: 0 0 18px rgba(34, 211, 238, 0.7);\n  animation: brb-pulse 1.4s ease-in-out infinite;\n}\n\n.brb__dot:nth-child(2) {\n  animation-delay: 0.25s;\n}\n\n.brb__dot:nth-child(3) {\n  animation-delay: 0.5s;\n}\n\n@keyframes brb-breathe {\n  0%, 100% {\n    transform: translate(-50%, -50%) scale(1);\n    opacity: 0.8;\n  }\n  50% {\n    transform: translate(-50%, -50%) scale(1.12);\n    opacity: 1;\n  }\n}\n\n@keyframes brb-rise {\n  from {\n    opacity: 0;\n    transform: translateY(40px);\n  }\n  to {\n    opacity: 1;\n    transform: translateY(0);\n  }\n}\n\n@keyframes brb-pulse {\n  0%, 100% {\n    transform: scale(0.7);\n    opacity: 0.4;\n  }\n  50% {\n    transform: scale(1.15);\n    opacity: 1;\n  }\n}",
  variables: "{\"screen\": {\"title\": \"EMPEZAMOS PRONTO\", \"subtitle\": \"El directo comienza en unos minutos, no te vayas\"}}",
};

const ultimoSeguidorTicker: EditorTemplate = {
  id: "ultimo-seguidor-ticker",
  name: "Ultimo Seguidor (ticker)",
  description: "Chip en la esquina inferior derecha que muestra el ultimo seguidor con un glifo de corazon y animacion de entrada deslizante.",
  html: "<div class=\"lf-chip\">\n  <span class=\"lf-glyph\">♥</span>\n  <span class=\"lf-label\">Ultimo seguidor:</span>\n  <span class=\"lf-name\">{{lastFollower.name}}</span>\n</div>",
  css: ".lf-chip {\n  position: absolute;\n  bottom: 48px;\n  right: 48px;\n  display: inline-flex;\n  align-items: center;\n  gap: 12px;\n  padding: 12px 22px;\n  font-family: system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif;\n  font-size: 26px;\n  line-height: 1;\n  color: #f4f4f5;\n  background: linear-gradient(135deg, rgba(17, 17, 24, 0.88), rgba(35, 18, 54, 0.88));\n  border: 1px solid rgba(147, 51, 234, 0.5);\n  border-radius: 999px;\n  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(255, 255, 255, 0.04);\n  backdrop-filter: blur(6px);\n  white-space: nowrap;\n  animation: lf-slide-in 0.7s cubic-bezier(0.18, 0.89, 0.32, 1.28) both;\n}\n\n.lf-glyph {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 34px;\n  height: 34px;\n  font-size: 22px;\n  color: #ffffff;\n  background: linear-gradient(135deg, #9333ea, #22d3ee);\n  border-radius: 50%;\n  box-shadow: 0 0 12px rgba(147, 51, 234, 0.7);\n  animation: lf-heartbeat 1.8s ease-in-out infinite;\n}\n\n.lf-label {\n  font-weight: 500;\n  letter-spacing: 0.3px;\n  color: #c4b5fd;\n  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);\n}\n\n.lf-name {\n  font-weight: 800;\n  color: #ffffff;\n  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8), 0 0 10px rgba(34, 211, 238, 0.45);\n}\n\n@keyframes lf-slide-in {\n  0% {\n    opacity: 0;\n    transform: translateX(120%);\n  }\n  100% {\n    opacity: 1;\n    transform: translateX(0);\n  }\n}\n\n@keyframes lf-heartbeat {\n  0%, 100% {\n    transform: scale(1);\n  }\n  15% {\n    transform: scale(1.18);\n  }\n  30% {\n    transform: scale(1);\n  }\n  45% {\n    transform: scale(1.12);\n  }\n}",
  variables: "{\"lastFollower\":{\"name\":\"GamerPro_99\"}}",
};


export const templateCategories: TemplateCategory[] = [
  { id: 'design-system', name: 'Design System', templates: designComponents },
  { id: 'alerts', name: 'Alertas', templates: [followAlert, donationAlert] },
  { id: 'lower-thirds', name: 'Lower Thirds', templates: [lowerThird] },
  { id: 'counters', name: 'Contadores / Metas', templates: [countdown, subGoalBar] },
  { id: "marca", name: "Marca", templates: [logoEsquinaGiratorio, socialMediaBar] },
  { id: "informacion", name: "Información", templates: [relojEnVivo, weatherChipTopLeft, nowPlayingMusicBar] },
  { id: "comunidad", name: "Comunidad", templates: [statsDelStreamPills, chatEnPantalla, ultimoSeguidorTicker] },
  { id: "juego", name: "Juego", templates: [scoreboardTopCenter] },
  { id: "camara", name: "Cámara", templates: [webcamFrameCornerAccents] },
  { id: "pantalla", name: "Pantalla", templates: [pantallaEmpezamosPronto] },
];
