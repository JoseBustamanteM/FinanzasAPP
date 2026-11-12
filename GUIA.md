# Mis Finanzas: guía de instalación

Toma unos 20 minutos y es gratis. Conviene hacerlo desde un computador.

## Cómo funciona la seguridad

1. **Cuentas creadas solo por ti.** Nadie puede registrarse por su cuenta: tú creas a cada persona en Supabase.
2. **Doble autenticación obligatoria (2FA).** Además de la contraseña, se pide un código de 6 dígitos de una app de autenticación (Google Authenticator, Microsoft Authenticator, etc.). Se configura la primera vez que la persona entra.
3. **La base de datos exige el 2FA.** Las reglas de Supabase solo entregan datos a sesiones que pasaron el código. Aunque alguien robe una contraseña, sin el celular de esa persona no ve nada.
4. **Cada persona ve solo lo suyo.** Las reglas RLS separan los datos por usuario.
5. **Conexión cifrada** (HTTPS) y sin scripts de terceros: el navegador los bloquea. Las librerías (pdf.js para leer estados de cuenta y Tesseract para leer fotos) van alojadas junto a la app, y los PDF y las fotos se procesan en tu dispositivo sin enviarse a ningún servidor.
6. **Dispositivos compartidos.** "Cerrar sesión" borra los datos de ese dispositivo. Además, si entra otra persona, la app borra primero lo que había del usuario anterior.

> Nota: tú, como administrador del proyecto Supabase, podrías ver los datos desde el panel (no van cifrados con una clave personal). Cuida la contraseña de tu cuenta de Supabase y actívale también 2FA (en tu perfil de supabase.com).

---

## Paso 1: Crear la base de datos en Supabase

1. Entra a **supabase.com**, crea una cuenta y toca **New project**. Elige la región **South America (São Paulo)**.
2. Ve a **SQL Editor → New query**. Pega todo el contenido de `schema.sql` y toca **Run**. Debe aparecer "Success".
3. Ve a **Authentication → Sign In / Providers**:
   - Desactiva **Allow new users to sign up**.
   - En **Email**, desactiva **Confirm email**.
4. Ve a **Authentication → Multi-Factor** y revisa que **TOTP (App Authenticator)** esté habilitado. Viene activado por defecto.
5. Ve a **Project Settings → API Keys** y copia la **Project URL** y la **Publishable key** (`sb_publishable_…`). Pégalas en `config.js`.

## Paso 2: Publicar la app en GitHub Pages

1. Crea una cuenta en **github.com** y luego un repositorio **New repository**. Ponle un nombre (ej: `finanzas`) y márcalo **Public**. En el repositorio solo va el código, nunca los datos.
2. Toca **Add file → Upload files** y sube todos los archivos (con `config.js` ya editado).
3. Ve a **Settings → Pages**, elige Branch **main** y **/(root)**, y toca **Save**.
4. En 1 o 2 minutos, la app queda en `https://TU-USUARIO.github.io/finanzas/`

## Paso 3: Crear las cuentas

Para cada persona, incluido tú: en Supabase ve a **Authentication → Users → Add user → Create new user**. Pon su correo y una contraseña inicial, y marca **Auto Confirm User**.

Después le pasas el enlace de la app, su correo y su contraseña. Puede cambiar la contraseña dentro de la app, en Ajustes.

## Paso 4: Primer ingreso de cada persona

1. Instala en el celular **Google Authenticator** o **Microsoft Authenticator**.
2. Abre el enlace de la app e ingresa con el correo y la contraseña.
3. La app muestra la pantalla para activar la doble autenticación:
   - **Desde el computador:** escanea el código QR con la app de autenticación.
   - **Desde el mismo celular:** toca "Abrir en mi app de autenticación" o copia la clave y agrégala a mano.
4. Escribe el código de 6 dígitos y listo.

En los demás dispositivos, cada vez que la persona inicia sesión: correo, contraseña y el código de la app. La sesión queda abierta en ese dispositivo hasta que la cierre.

## Paso 5: Instalarla como app

- **Android (Chrome):** menú ⋮ → **Instalar app**.
- **iPhone (Safari):** Compartir → **Agregar a inicio**. Tiene que ser desde Safari.
- **Computador (Chrome o Edge):** ícono de instalar en la barra de direcciones, o simplemente guárdala en marcadores.

---

## Problemas comunes

- **Alguien cambió de celular y perdió la app de autenticación:** en Supabase, ve a Authentication → Users, abre a esa persona y elimina su factor MFA. La próxima vez que entre, la app le pide configurarlo de nuevo.
- **Olvidó la contraseña:** cámbiasela tú desde Authentication → Users.
- **Quitarle el acceso a alguien:** elimina su usuario en Authentication → Users. Eso borra también sus datos.

## Uso diario

- **+** registra un movimiento: gasto, ingreso, transferencia o pago de tarjeta.
- **Atajos:** lo que repites queda a un toque. Si el atajo tiene monto fijo, se registra al instante y se puede deshacer.
- **Pagos:** en *Tarjetas* ves cada tarjeta de crédito con sus cuotas, compras y cargos del mes; en *Recurrentes*, lo que pagas sin tarjeta (arriendo, cuentas). Agrega cada pago con su día de vencimiento y, si tiene fin, sus cuotas. Las compras con débito siguen en *Movimientos*, donde puedes filtrar por medio de pago.
- **Compras en cuotas:** en **+ → Gasto → Crédito** escribe el número de cuotas y, si tiene interés, el valor de cada una. Queda en *Pagos → Tarjetas* y la cuota avanza sola cada mes.
- **Foto de la compra:** en **+**, toca *Leer foto de la compra* y elige una captura del detalle del movimiento en la app del banco. La app lee el monto, la fecha y el comercio (y las cuotas, si el banco ya las muestra). La foto se lee en tu dispositivo y no se envía a ningún servidor. La primera vez descarga el lector (unos 6 MB). Usar el nombre del banco ayuda a que, al importar el estado de cuenta, la compra no se duplique.
- **Mes en que se paga:** en las compras con crédito, la app estima el mes según la fecha de facturación de tu último estado de cuenta importado. Puedes cambiarlo, y al importar el estado de cuenta se corrige.
- **Pagos fijos de tarjeta:** suscripciones como YouTube pueden quedar como *Pago fijo mensual* al importar, o con *Convertir en pago fijo mensual* al abrir la compra.
- **Me deben:** toca ÷ en una compra, cuota o pago para dividirlo con otra persona, por porcentaje o monto. En las cuotas y pagos eliges si es mes a mes o solo ese mes. Lo que te deben de los gastos de un mes suma a tu balance de ese mes, aunque aún no te paguen; el pago recibido no se vuelve a sumar. En cada mes ves qué está pendiente o atrasado; al tocar *Pagar* se crea el movimiento. Las cuotas avanzan solas cada mes, igual que en la facturación del banco. Para deshacerlo, toca *✓ Pagado* y elimina ese movimiento.
- **Yo debo:** si le debes a alguien compras hechas con su tarjeta, en *Pagos → Yo debo* sube el PDF de su estado de cuenta (por ahora CMR Falabella o BCI), elige de quién es y marca tus líneas: completas, un porcentaje o un monto por cuota. Cada cuota cuenta como gasto tuyo en el mes en que se cobra, y avanza sola cada mes. Cuando le pagues, toca *Registrar pago*: ese pago baja la deuda y no se vuelve a contar como gasto. Si subes el estado de cuenta del mes siguiente, lo que ya registraste aparece marcado para no duplicarlo. Del PDF solo se guardan las líneas que marcas.
- **Importar estado de cuenta:** en Pagos, sube el PDF de CMR Falabella o BCI, revisa cada línea y confirma. El estado de cuenta queda en el mes que elijas en la revisión; por defecto, el mes que tienes abierto. Al pagar el total de la tarjeta, sus cuotas del mes quedan pagadas; si pagas una parte, siguen pendientes. **No subas tus PDF al repositorio.**
- **Tarjeta de crédito:** agrega tus tarjetas en Ajustes (o al registrar una compra) y registra las compras como *Gasto → Crédito*, eligiendo la tarjeta. En Inicio ves cuánto debes en cada una. Cuando pagues el estado de cuenta, usa *Pago tarjeta*; ese pago no se cuenta dos veces.
- **Bencina:** si anotas los litros y el kilometraje llenando el estanque completo, la app calcula el rendimiento en km/l.
- **Sin internet** también funciona: los cambios se sincronizan cuando vuelve la conexión.

## Actualizar la app

Si cambias algún archivo, súbelo de nuevo a GitHub y sube el número en `sw.js` (`finanzas-v3` → `finanzas-v4`). Así los dispositivos descargan la versión nueva.
