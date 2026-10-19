const express = require("express");
const cors = require("cors");
const path = require("path");
const app = express();
//const PDFDocument = require("pdfkit");
const fs = require("fs");
const multer = require("multer");
app.use(express.urlencoded({ extended: true }));

const { PDFDocument, StandardFonts, rgb  } = require("pdf-lib");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB por archivo
    files: 20,
    fieldSize: 20 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/jpg",
      "image/gif",
      "image/bmp",
      "image/tiff"
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);   // ✔ aceptar archivo
    } else {
      cb(null, false);  // ❌ rechazar archivo
    }
  }
});

//const { PDFDocument: PDFLibDocument } = require("pdf-lib");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
//const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const Mailjet = require('node-mailjet');
// Almacenamiento temporal en memoria
let pdfsTemporales = [];




app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public")); // servir login, formulario, encabezado, etc.


// Pool PostgreSQL (Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);

app.use(session({
  store: new PgSession({
    pool: pool, // tu pool de PostgreSQL
    tableName: "session"
  }),
  secret: process.env.SESSION_SECRET || "supersecret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // en Render con HTTPS se puede poner true
    maxAge: 1000 * 60 * 60 * 2 // 2 horas
  }
}));

function requireLogin(req, res, next) {
  if (!req.session.username) {
    return res.redirect("/index.html");
  }
  next();
}

const mailjet = Mailjet.apiConnect(
  process.env.MJ_USER,
  process.env.MJ_PASS
);


app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const result = await pool.query(
    "SELECT * FROM operarios_cgc WHERE username = $1",
    [username]
  );

  if (result.rows.length === 0) {
    return res.redirect("/index.html?error=1");
  }

  const user = result.rows[0];

  const ok = await bcrypt.compare(password, user.password_hash);

  if (!ok) {
    return res.redirect("/index.html?error=1");
  }

  req.session.username = user.username;
  req.session.nombre = user.nombre;
  req.session.empresa = user.empresa; // NUEVO
  req.session.rol = user.rol;         // NUEVO

  res.redirect("/menu.html");
});


app.get("/formulario.html", requireLogin, (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "formulario.html"));
});

app.get("/api/me", (req, res) => {
  res.json({ username: req.session.username,empresa: req.session.empresa,rol: req.session.rol });
  pdfsTemporales = [];

  
});
function esAdmin(req) {
  return req.session && req.session.rol === "admin";
}




app.get("/historial", async (req, res) => {
    let { matricula,tipo_vehiculo, fechaInicio, fechaFin, ubicacion} = req.query;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
  
    let where = [];
    let params = [];

    if (matricula && matricula.trim() !== "") {
        params.push(matricula.trim());
        where.push(`matricula = $${params.length}`);
    }
    if (tipo_vehiculo && tipo_vehiculo.trim() !== "") {
        params.push(tipo_vehiculo.trim());
        where.push(`tipo_vehiculo = $${params.length}`);
    }    

    if (ubicacion && ubicacion.trim() !== "") {
        params.push(ubicacion.trim());
        where.push(`ubicacion = $${params.length}`);
    }

    if (fechaInicio && fechaFin) {
        params.push(fechaInicio);
        params.push(fechaFin);
        where.push(`fecha_revision::date BETWEEN $${params.length - 1} AND $${params.length}`);
    } else if (fechaInicio) {
        params.push(fechaInicio);
        where.push(`fecha_revision::date >= $${params.length}`);
    } else if (fechaFin) {
        params.push(fechaFin);
        where.push(`fecha_revision::date <= $${params.length}`);
    }

    if (where.length === 0) {
        return res.status(400).json({ error: "Debe indicar vehiculo, fecha o ubicación" });
    }

    const whereSQL = "WHERE " + where.join(" AND ");

    let query = "";
    let countQuery = "";
            query = `
                SELECT numero_orden,tipo_vehiculo,matricula,ubicacion,indicativo,marca,modelo,fecha_revision,observaciones,operario
                FROM registros_vehiculos
                ${whereSQL}
                ORDER BY fecha_revision DESC
                LIMIT $${params.length + 1} OFFSET $${params.length + 2}
            `;
        

        countQuery = `
            SELECT COUNT(*) AS total
            FROM registros_vehiculos
            ${whereSQL}
        `;
    

    try {
        const result = await pool.query(query, [...params, limit, offset]);
        const total = await pool.query(countQuery, params);

        res.json({
            datos: result.rows,
            total: parseInt(total.rows[0].total),
            page,
            limit
        });

    } catch (err) {
        console.error("❌ ERROR EN /historial:", err);
        res.status(500).json({ error: "Error en la base de datos" });
    }
});




app.get('/prioridades', requireLogin, (req, res) => {
  res.sendFile(process.cwd() + '/public/prioridades.html');
});

app.get('/api/prioridades', async (req, res) => {
  if (!req.session || !req.session.username) {
    return res.status(401).json({ error: "Sesión caducada" });
  }

  let empresa = req.query.empresa;
  let ubicacion = req.query.ubicacion || "";

  if (!esAdmin(req)) {
    empresa = req.session.empresa;
  }

  let tabla_maestra = "";
  let tabla_registros = "";

  if (empresa === "Global") {
    tabla_maestra = "global_maquinas";
    tabla_registros = "registro_de_equipo";
  } else if (empresa === "Titsa") {
    tabla_maestra = "titsa_maquinas_provisional";
    tabla_registros = "registro_titsa";
  } else {
    return res.status(400).json({ error: "Empresa no válida" });
  }

  try {
    let params = [];
    let where = [];

    if (ubicacion) {
      params.push(ubicacion);
      where.push(`m.ubicacion = $${params.length}`);
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";
    let filtroInventario = "";

    if (empresa === "Titsa") {
      filtroInventario = `
        AND m.matricula IN (
          SELECT id_maquina FROM titsa_maquinas_provisional
        )
      `;
    }

    const sql = `
      SELECT
        m.id_maquina,
        m.maquina,
        m.ubicacion,
        TO_CHAR(MAX(r.fecha_revision), 'YYYY-MM-DD') AS ultima_revision,
        CURRENT_DATE - MAX(r.fecha_revision) AS dias_desde_revision
      FROM ${tabla_maestra} m
      LEFT JOIN ${tabla_registros} r
        ON r.id_maquina = m.id_maquina
      ${whereSQL}
      ${filtroInventario}
      GROUP BY m.id_maquina, m.maquina, m.ubicacion
      ORDER BY m.id_maquina;
    `;



    const { rows } = await pool.query(sql, params);

    const resultados = rows.map(r => {
      const dias = Number(r.dias_desde_revision);
      let prioridad = 3;

      if (!r.ultima_revision || isNaN(dias)) {
        prioridad = 1;
      } else {
        if (empresa === "Global") {
          if (dias >= 90) prioridad = 1;
          else if (dias >= 45) prioridad = 2;
        }

        if (empresa === "Titsa") {
          if (dias >= 30) prioridad = 1;
          else if (dias >= 15) prioridad = 2;
        }
      }

      return {
        id_maquina: r.id_maquina,
        maquina: r.maquina,
        ubicacion: r.ubicacion,
        ultima_revision: r.ultima_revision,
        prioridad
      };
    });

    resultados.sort((a, b) => a.prioridad - b.prioridad);

    res.json(resultados);

  } catch (err) {
    console.error("❌ ERROR EN /api/prioridades:", err);
    res.status(500).json({ error: err.message });
  }
});



// Ruta para insertar datos
app.post("/api/insert", requireLogin, upload.any(), async (req, res) => {
  try {
    if (!req.session || !req.session.username) {
      return res.status(401).json({ error: "Sesión caducada" });
    }
    const d = req.body;
    
      const sql = `
        INSERT INTO registros_vehiculos (
          numero_orden, tipo_vehiculo, matricula, ubicacion, indicativo,
          marca, modelo,kilometros,litros_cisternas,fecha_revision,proxima_revision,
          operario, observaciones
        ) VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,$10,
          $11,$12,$13
        )
      `;

      const values = [
        d.numero_orden,d.tipo_vehiculo,d.matricula,d.ubicacion,d.indicativo,
        d.marca,d.modelo,d.kilometros,d.litros_cisternas,d.fecha_revision,d.proxima_revision,
        req.session.username,d.observaciones 
        
      ];

      const result = await pool.query(sql, values);
      return res.json({ status: "OK"});

  } catch (err) {
    console.error(err);
    res.status(500).send("Error al insertar");
  }
});




app.get("/api/maquinas/:empresa", async (req, res) => {
  let { empresa } = req.params;

  if (!esAdmin(req)) {
    empresa = req.session.empresa;
  }

  const tabla = empresa === "Titsa" ? "titsa_maquinas_provisional" : "global_maquinas";

  try {
    const sql = `SELECT id_maquina, maquina FROM ${tabla} ORDER BY id_maquina ASC`;
    const result = await pool.query(sql);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error obteniendo máquinas");
  }
});


app.get("/api/ubicaciones", async (req, res) => {

  const result = await pool.query(
    `SELECT DISTINCT ubicacion
     FROM flota_vehiculos_cgc
     ORDER BY ubicacion`
  );

  res.json(result.rows);
});

app.get("/api/todasmaquinas/:empresa/:ubicacion", async (req, res) => {
  const {ubicacion} = req.params;
    let { empresa } = req.params;

  if (!esAdmin(req)) {
    empresa = req.session.empresa;
  }
  let tabla = "";
  if (empresa === "Titsa") tabla = "titsa_maquinas";
  else tabla = "global_maquinas";

  const result = await pool.query(
    `SELECT id_maquina, maquina
     FROM ${tabla}
     WHERE ubicacion = $1
     ORDER BY maquina`,
    [ubicacion]
  );

  res.json(result.rows);
});

app.get("/api/tipos/:ubicacion", async (req, res) => {
  const {ubicacion} = req.params;
   
  let tabla = "";
  
  const result = await pool.query(
    `SELECT DISTINCT tipo_vehiculo
     FROM flota_vehiculos_cgc
     WHERE ubicacion = $1
     ORDER BY tipo_vehiculo`,
    [ubicacion]
  );

  res.json(result.rows);
});

app.get("/api/matriculas/:tipo_vehiculo", async (req,res) => {

    const result = await pool.query(`
        SELECT matricula
        FROM flota_vehiculos_cgc
        WHERE tipo_vehiculo = $1
        ORDER BY matricula
    `,[req.params.tipo_vehiculo]);

    res.json(result.rows);
});


// Valores predefinidos Global (meter titsa)
app.get("/api/valores/:matricula", async (req, res) => {
  let {matricula } = req.params;

  try {
    const sql = `SELECT * FROM flota_vehiculos_cgc WHERE "matricula" = $1`;
    const result = await pool.query(sql, [matricula]);

    if (result.rows.length === 0) {
      return res.status(404).send("No hay valores predefinidos para esa máquina");
    }

    res.json(result.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).send("Error consultando valores predefinidos");
  }
});

app.post("/api/subirInforme", (req, res) => {
    upload.array("pdfs")(req, res, err => {

        // 1. ERROR DE MULTER (tamaño, número de archivos, etc.)
        if (err) {
            console.error("ERROR MULTER:", err);

            return res.status(400).json({
                ok: false,
                msg: "Los archivos son demasiado grandes o demasiados.",
                error: err.message,
                lista: pdfsTemporales.map(x => x.nombre)
            });
        }

        // 2. SI NO HAY ARCHIVOS
        if (!req.files || req.files.length === 0) {
            return res.json({
                ok: true,
                lista: pdfsTemporales.map(x => x.nombre)
            });
        }

        // 3. GUARDAR ARCHIVOS EN MEMORIA
        for (const f of req.files) {
            pdfsTemporales.push({
                nombre: f.originalname,
                buffer: f.buffer
            });
        }

        // 4. RESPUESTA CORRECTA
        res.json({
            ok: true,
            lista: pdfsTemporales.map(x => x.nombre)
        });
    });
});




app.post("/api/enviarInformes", async (req, res) => {
    const { empresa } = req.body;
    // Normalizamos para comparar
    const emp = (empresa || "").toLowerCase();

    if (pdfsTemporales.length === 0) {
        return res.json({ msg: "No hay PDFs cargados" });
    }

    let destinatarios = [];

    /*if (emp.toLowerCase().includes("titsa")) {
        destinatarios = [
            { Email: "administracion@grupobaezcan.com" },
            { Email: "gestionbaezcan@gmail.com" },
            { Email: "grupobaezcan@gmail.com" },
            { Email: "raulx3000@gmail.com" },
            { Email: "informes@grupobaezcan.com" }
        ];
    }
*/

   // if (emp.toLowerCase().includes("global")) {
        destinatarios = [
            { Email: "informes@grupobaezcan.com" }
        ];
   // }

    const attachments = pdfsTemporales.map(p => ({
        ContentType: "application/pdf",
        Filename: p.nombre,
        Base64Content: p.buffer.toString("base64")
    }));

    await mailjet
        .post("send", { version: "v3.1" })
        .request({
            Messages: [
                {
                    From: {
                        Email: "informes@grupobaezcan.com",
                        Name: "Grupo Baezcan"
                    },
                    To: destinatarios,
                    Subject: `Informes del día - ${req.session.username}`,
                    HTMLPart: `<p>Adjunto informes del día.</p>`,
                    Attachments: attachments
                }
            ]
        });

    pdfsTemporales = []; // limpiar

    res.json({ msg: "Informes enviados correctamente" });
});



async function enviarCorreo(pdfBuffer, filename, operario,maquina,empresa) {
  try {
    // Normalizamos para comparar
    const emp = (empresa || "").toLowerCase();
    
    // Correos por defecto (Baezcan)
    let destinatarios = [
      { Email: "administracion@grupobaezcan.com" },
        { Email: "gestionbaezcan@gmail.com" },
        { Email: "informes@grupobaezcan.com" }
    ];

    // Si la empresa es TITSA
/*if (emp.includes("titsa")) {
      destinatarios = [
        { Email: "raulglezespino@gmail.com" },
        { Email: "administracion@grupobaezcan.com" },
      { Email: "gestionbaezcan@gmail.com" },
      { Email: "grupobaezcan@gmail.com" },
      { Email: "informes@grupobaezcan.com" }
      ];
   }
*/
    // Si la empresa es GLOBAL
    if (emp.includes("global")) {
      destinatarios = [
        { Email: "ogonzalez@guaguasglobal.com" },
        { Email: "administracion@grupobaezcan.com" },
        { Email: "gestionbaezcan@gmail.com" },
        { Email: "informes@grupobaezcan.com" }
      ];
    }

    await mailjet
      .post("send", { version: "v3.1" })
      .request({
        Messages: [
          {
            From: {
              Email: "informes@grupobaezcan.com",
              Name: "Grupo Baezcan"
            },
            To: destinatarios,
            Subject: `Informe diario - ${operario}`,
            HTMLPart: `
              <p>Hola,</p>
              <p>Adjunto el informe de maquinaria <strong>${maquina}</strong> del operario <strong>${operario}</strong>.</p>
              <p>Saludos,<br>Grupo Baezcan</p>
            `,
            Attachments: [
              {
                ContentType: "application/pdf",
                Filename: filename,
                Base64Content: Buffer.from(pdfBuffer).toString("base64")
              }
            ]
          }
        ]
      });

    console.log("Correo enviado correctamente");
  } catch (err) {
    console.error("Error enviando correo:", err);
  }
}

app.get("/api/informes", requireLogin, async (req, res) => {
  try {
    const { empresa, id_maquina, fechaInicio, fechaFin, tipo } = req.query;

    const tabla = empresa === "Titsa"
      ? "informes_maquinaria_titsa"
      : "informes_maquinaria_global";

    let where = [];
    let params = [];

    if (id_maquina) {
      params.push(id_maquina);
      where.push(`id_maquina = $${params.length}`);
    }

    if (fechaInicio) {
      params.push(fechaInicio);
      where.push(`fecha >= $${params.length}`);
    }

    if (fechaFin) {
      params.push(fechaFin);
      where.push(`fecha <= $${params.length}`);
    }

    if (tipo) {
      params.push(tipo);
      where.push(`tipo = $${params.length}`);
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const result = await pool.query(
      `SELECT id_maquina, empresa, fecha, tipo, id
       FROM ${tabla}
       ${whereSQL}
       ORDER BY fecha DESC`
      , params
    );

    res.json(result.rows);

  } catch (err) {
    console.error("❌ Error listando informes:", err);
    res.status(500).json({ error: "Error listando informes" });
  }
});


app.get("/api/informe/:empresa/:id", requireLogin, async (req, res) => {
  try {
    const { empresa, id } = req.params;

    const tabla = empresa === "Titsa"
      ? "informes_maquinaria_titsa"
      : "informes_maquinaria_global";

    const result = await pool.query(
      `SELECT informe, id_maquina, fecha, tipo, id
       FROM ${tabla}
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Informe no encontrado" });
    }

    const row = result.rows[0];

    const filename = `Informe_${row.id_maquina}_${row.fecha}_${row.tipo}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    res.send(row.informe);

  } catch (err) {
    console.error("❌ Error descargando informe:", err);
    res.status(500).json({ error: "Error descargando informe" });
  }
});


app.post("/api/pdf", requireLogin, upload.array("Adjuntos", 10), async (req, res) => {
  try {
    const data = req.body;
    const operario = req.session.username;

    function sanitizeFilename(name) {
      return (name || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9_\-]/g, "_");
    }

    const year = new Date().getFullYear();
    const filename = `Informe_${sanitizeFilename(data.matricula)}.pdf`;

    // -----------------------------
    // 1) CREAR PDF PRINCIPAL CON PDF-LIB
    // -----------------------------
    const pdfDoc = await PDFDocument.create();
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // A4: 595 x 842
    let page = pdfDoc.addPage([595, 842]);
    let { width, height } = page.getSize();

    const margin = 30;
    let y = height - margin; // empezamos arriba

    const cfg = {
        Direccion: "c/. Viera y Clavijo 34-36/5ºPlanta",
        Provincia: "Las Palmas",
        CPostal: "35002",
        Ciudad: "Las Palmas de G.C.",
        CIF: "B-35604487",
        Telefono1: "928367301",
        Email: "administracion@ayudashidraulicas.com"
    };

    function drawText(txt, x, y, opts = {}) {
      page.drawText(txt || "", {
        x,
        y,
        size: opts.size || 9,
        font: opts.bold ? fontBold : fontRegular,
        color: opts.color || rgb(0, 0, 0),
        maxWidth: opts.width
      });
    }

    function drawRect(x, y, w, h, opts = {}) {
      page.drawRectangle({
        x,
        y,
        width: w,
        height: h,
        borderColor: opts.borderColor || rgb(0, 0, 0),
        borderWidth: opts.borderWidth || 1,
        color: opts.fillColor || undefined
      });
    }

    function addFlexibleRow(yRow, columns, config = {}) {
      const x = config.x || margin;
      const rowHeight = config.rowHeight || 22;
      const totalWidth = config.totalWidth || (width - margin * 2);

      const totalSpan = columns.reduce((s, col) => s + (col.span || 1), 0);
      const baseWidth = totalWidth / totalSpan;

      let cursorX = x;

      columns.forEach(col => {
        const span = col.span || 1;
        const colWidth = span * baseWidth;

        const labelWidth = colWidth * 0.4;
        const valueWidth = colWidth * 0.6;

        // fondo gris label
        drawRect(cursorX, yRow - rowHeight, labelWidth, rowHeight, {
          fillColor: rgb(0.9, 0.9, 0.9)
        });

        // bordes
        drawRect(cursorX, yRow - rowHeight, labelWidth, rowHeight);
        drawRect(cursorX + labelWidth, yRow - rowHeight, valueWidth, rowHeight);

        // textos
        drawText(col.label || "", cursorX + 3, yRow - rowHeight + 6, {
          size: 8,
          width: labelWidth - 6
        });

          // VALUE (solo Ubicación cambia tamaño)
          const isUbicacion = col.label === "Ubicación";

          drawText(col.value || "", cursorX + labelWidth + 3, yRow - rowHeight + 6, {
            size: isUbicacion ? 6 : 8,
            width: valueWidth - 6
          });

        cursorX += colWidth;
      });

      return yRow - rowHeight;
    }

    // -----------------------------
    // 2) ENCABEZADO (IMAGEN + TEXTO)
    // -----------------------------
    // Imagen encabezado
    try {
      const imgPath = path.join(process.cwd(), "public", "encabezado.PNG");
      if (fs.existsSync(imgPath)) {
        const imgBytes = fs.readFileSync(imgPath);
        const img = await pdfDoc.embedPng(imgBytes);
        const imgWidth = 320;
        const imgHeight = (imgWidth / img.width) * img.height;
        page.drawImage(img, {
          x: margin,
          y: y - imgHeight,
          width: imgWidth,
          height: imgHeight
        });
      }
    } catch (err) {
      console.log("Error cargando encabezado:", err);
    }

    // texto empresa derecha
    drawText(
      "c/. Tamaduste N5 nave 2 P.I. Majoreras\n" +
      "35259 - Ingenio - Las Palmas\n" +
      "Teléfono - 677 927 340\n" +
      "e-mail  administracion@ayudashidraulicas.com",
      350,
      y - 10,
      { size: 9, width: 200 }
    );

    // título
    drawText("REGISTRO DE VEHICULO", margin, y - 60, {
      size: 16,
      bold: true
    });

    y -= 90;

    // -----------------------------
    // 3) CABECERA FLEXIBLE
    // -----------------------------

    y = addFlexibleRow(y, [
      { label: "EMPRESA", value: "CONSORCIO GRAN CANARIA", span: 8 },
      { label: "Hoja Nº", value: data.id, span: 4 }
    ]);

    y = addFlexibleRow(y, [
      { label: "Dirección", value: cfg.Direccion, span: 8 },
      { label: "Provincia", value: cfg.Provincia, span: 4 }
    ]);

    y = addFlexibleRow(y, [
      { label: "C. Postal", value: cfg.CPostal, span: 3 },
      { label: "Ciudad", value: cfg.Ciudad, span: 5 },
      { label: "CIF / NIF", value: cfg.CIF, span: 4 }
    ]);

    y = addFlexibleRow(y, [
      { label: "Teléfono 1", value: cfg.Telefono1, span: 4 },
      { label: "e-mail", value: cfg.Email, span: 8 }
    ]);

    y -= 20;

    // -----------------------------
    // 4) TABLA SUPERIOR (MAQUINARIA)
    // -----------------------------
    y = addFlexibleRow(y, [
      { label: "Numero Orden", value: data.numero_orden, span: 4 },
      { label: "Tipo vehiculo", value: data.tipo_vehiculo, span: 5 },
      { label: "Matricula", value: data.matricula, span: 2 },
    ]);

    y = addFlexibleRow(y, [
      { label: "Ubicación", value: data.ubicacion },
      { label: "Indicativo", value: data.indicativo }
    ]);

    y = addFlexibleRow(y, [
      { label: "Marca", value: data.marca },
      { label: "Modelo", value: data.modelo }
      
    ]);

    y = addFlexibleRow(y, [
      { label: "Kilometros", value: data.kilometros },
      { label: "Litros cisternas", value: data.litros_cisternas }
    ]);

    y -= 40;

    // -----------------------------
    // 5) TABLA INFERIOR
    // -----------------------------
    const tableX = margin;
    const tableWidth = width - margin * 2;

    // título
    drawRect(tableX, y - 25, tableWidth, 25);
    drawText("MANTENIMIENTO / REVISION / REPARACION", tableX + 5, y - 18, {
      size: 11,
      bold: true
    });
    y -= 25;

    // cabecera columnas
    drawRect(tableX, y - 25, 100, 25);
    drawText("Fecha", tableX + 30, y - 18, { size: 10 });

    drawRect(tableX + 100, y - 25, 320, 25);
    drawText("TRABAJO REALIZADO / MATERIALES EMPLEADOS", tableX + 110, y - 18, {
      size: 9
    });

    drawRect(tableX + 420, y - 25, 100, 25);
    drawText("Parte Nº", tableX + 450, y - 18, { size: 10 });

    y -= 25;

    // cuerpo
    drawRect(tableX, y - 150, 100, 150);
    drawText(data.fecha_revision || "", tableX + 20, y - 140, { size: 9 });

    drawRect(tableX + 100, y - 150, 320, 150);
    drawText(data.observaciones || "", tableX + 105, y - 10, {
      size: 9,
      width: 310
    });

    drawRect(tableX + 420, y - 150, 100, 150);

    y -= 160;

    // línea y textos finales
    page.drawLine({
      start: { x: margin, y: y },
      end: { x: width - margin, y: y },
      thickness: 1,
      color: rgb(0, 0, 0)
    });

    drawText(`PRÓXIMA REVISIÓN: ${data.proxima_revision || ""}`, margin, y - 15, {
      size: 10
    });
    drawText(`OPERARIO: ${operario}`, margin, y - 30, { size: 10 });

    // -----------------------------
    // 6) ADJUNTOS (IMÁGENES + PDFs) EN EL MISMO DOCUMENTO
    // -----------------------------
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        // IMÁGENES
        if (file.mimetype.startsWith("image/")) {
          const imgBytes = file.buffer;
          let img;
          if (file.mimetype === "image/png") {
            img = await pdfDoc.embedPng(imgBytes);
          } else {
            img = await pdfDoc.embedJpg(imgBytes);
          }

          const imgPage = pdfDoc.addPage([595, 842]);
          const maxW = 550;
          const maxH = 780;
          let imgW = img.width;
          let imgH = img.height;
          const ratio = Math.min(maxW / imgW, maxH / imgH);
          imgW *= ratio;
          imgH *= ratio;

          imgPage.drawImage(img, {
            x: (595 - imgW) / 2,
            y: (842 - imgH) / 2,
            width: imgW,
            height: imgH
          });

          continue;
        }

        // PDFs → fusionar páginas dentro del mismo pdfDoc
        if (file.mimetype === "application/pdf") {
          const externalPdf = await PDFDocument.load(file.buffer);
          const indices = externalPdf.getPageIndices();
          const copiedPages = await pdfDoc.copyPages(externalPdf, indices);
          copiedPages.forEach(p => pdfDoc.addPage(p));
        }
      }
    }

    // -----------------------------
    // 7) GUARDAR PDF FINAL
    // -----------------------------
    const finalPdf = await pdfDoc.save();

    // 8) ENVIAR POR CORREO
    await enviarCorreo(finalPdf, filename, operario, data.Maquina, data.Empresa);

    // ===============================
    //  GUARDAR INFORME EN BASE DE DATOS
    // ===============================
    try {

      await pool.query(
        `INSERT INTO informes_vehiculos_cgc (matricula, fecha, informe, tipo)
         VALUES ($1, CURRENT_DATE, $2, $3)`,
        [
          data.matricula,
          Buffer.from(finalPdf),
          "mantenimiento rutinario"
        ]
      );
    } catch (err) {
      console.error("❌ Error guardando informe en BD:", err);
    }


    // 9) ENVIAR AL NAVEGADOR
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.send(Buffer.from(finalPdf));

  } catch (err) {
    console.error("ERROR /api/pdf:", err);
    res.status(500).json({ error: "Error generando PDF" });
  }
});



app.post("/api/pdfInventario", upload.none(), requireLogin, async (req, res) => {
  try {
    const { empresa, ubicacion, marca, busqueda, lote } = req.body;


    // 1) Selección de tabla REAL
    const tabla = empresa === "Titsa"
      ? "titsa_maquinas_provisional"
      : "global_maquinas";

    // 2) Construcción dinámica del WHERE
    let where = [];
    let params = [];

    if (ubicacion) {
      params.push(ubicacion);
      where.push(`ubicacion = $${params.length}`);
    }

    if (marca) {
      params.push(marca);
      where.push(`marca = $${params.length}`);
    }

    if (busqueda) {
      params.push(`%${busqueda.toLowerCase()}%`);
      where.push(`LOWER(maquina) LIKE $${params.length}`);
    }

    if (empresa === "Titsa" && lote) {
      params.push(lote);
      where.push(`lote = $${params.length}`);
    }


    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // 3) Consulta EXACTA del inventario
    const sql = `
      SELECT id_maquina, maquina, ubicacion, marca, modelo,num_serie
      FROM ${tabla}
      ${whereSQL}
      ORDER BY id_maquina
    `;

    const r = await pool.query(sql, params);
    const datos = r.rows;

    // 4) Crear PDF
    const PDFDocument = require("pdfkit");
    const doc = new PDFDocument({ margin: 30 });

    let buffers = [];
    doc.on("data", buffers.push.bind(buffers));
    doc.on("end", () => {
      const pdf = Buffer.concat(buffers);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=inventario.pdf");
      res.send(pdf);
    });

    // Título
    doc.font("Helvetica-Bold").fontSize(18);
    doc.text("Inventario de maquinaria", { align: "center" });
    doc.moveDown();

    // Cabecera tabla
  const headers = ["ID", "Máquina", "Ubicación", "Marca", "Modelo","Num_serie"];
  const colWidths = [60, 170, 120, 60, 80,140];

  let y = 100;

  function drawHeader() {
    doc.font("Helvetica-Bold").fontSize(9);
    let x = 30;

    headers.forEach((h, i) => {
      doc.rect(x, y, colWidths[i], 20).stroke();
      doc.text(h, x + 3, y + 6, { width: colWidths[i] - 6 });
      x += colWidths[i];
    });

    y += 20;
  }

  function drawRow(values, isHeader = false) {
    doc.font(isHeader ? "Helvetica-Bold" : "Helvetica").fontSize(9);

    // 1) calcular altura necesaria según el texto
    let maxHeight = 0;
    values.forEach((v, i) => {
      const text = v || "";
      const h = doc.heightOfString(text, {
        width: colWidths[i] - 6,
        align: "left"
      });
      if (h > maxHeight) maxHeight = h;
    });

    const rowHeight = Math.max(18, maxHeight + 8); // padding

    // 2) salto de página si no cabe
    if (y + rowHeight > doc.page.height - 40) {
      doc.addPage();
      y = 50;
      drawHeader();
    }

    // 3) dibujar fila
    let x = 30;
    values.forEach((v, i) => {
      doc.rect(x, y, colWidths[i], rowHeight).stroke();
      doc.text(v || "", x + 3, y + 4, {
        width: colWidths[i] - 6
      });
      x += colWidths[i];
    });

    y += rowHeight;
  }

  // título
  doc.font("Helvetica-Bold").fontSize(18);
  doc.text("Inventario de maquinaria", { align: "center" });
  doc.moveDown();

  y = 100;
  drawHeader();

  datos.forEach(row => {
    drawRow([
      row.id_maquina,
      row.maquina,
      row.ubicacion,
      row.marca,
      row.modelo,
      row.num_serie
    ]);
  });


    doc.end();

  } catch (err) {
    console.error("ERROR PDF INVENTARIO:", err);
    res.status(500).json({ error: "Error generando PDF" });
  }
});


app.get("/api/inventario", async (req, res) => {
  const empresa = req.query.empresa;
  const ubicacion = req.query.ubicacion || "";
  const marca = req.query.marca || "";
  const busqueda = req.query.busqueda || "";
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const lote = req.query.lote || "";


  const tabla = empresa === "Titsa" ? "titsa_maquinas_provisional" : "global_maquinas";

  


  let where = [];
  let params = [];
  

  if (ubicacion) {
    params.push(ubicacion);
    where.push(`ubicacion = $${params.length}`);
  }

  if (marca) {
    params.push(marca);
    where.push(`marca = $${params.length}`);
  }

  if (busqueda) {
    params.push(`%${busqueda.toLowerCase()}%`);
    where.push(`LOWER(maquina) LIKE $${params.length}`);
  }

  if (empresa === "Titsa" && lote) {
    params.push(lote);
    where.push(`lote = $${params.length}`);
  }

  const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await pool.query(
    `SELECT COUNT(*) FROM ${tabla} ${whereSQL}`,
    params
  );

  const rows = await pool.query(
    `SELECT id_maquina, maquina, ubicacion, marca, modelo
     FROM ${tabla}
     ${whereSQL}
     ORDER BY id_maquina
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  res.json({
    total: Number(total.rows[0].count),
    page,
    limit,
    datos: rows.rows
  });
});



app.get("/api/inventario/ubicaciones", async (req, res) => {
  const empresa = req.query.empresa;
  const tabla = empresa === "Titsa" ? "titsa_maquinas_provisional" : "global_maquinas";

  const r = await pool.query(`SELECT DISTINCT ubicacion FROM ${tabla} ORDER BY ubicacion`);
  res.json(r.rows);
});

app.get("/api/inventario/marcas", async (req, res) => {
  const empresa = req.query.empresa;
  const tabla = empresa === "Titsa" ? "titsa_maquinas_provisional" : "global_maquinas";

  const r = await pool.query(`SELECT DISTINCT marca FROM ${tabla} WHERE marca IS NOT NULL ORDER BY marca`);
  res.json(r.rows);
});
//--------------------------------------------------


//-----------------------------------------------------
app.get("/api/prioridades/ubicaciones", async (req, res) => {
  let empresa = req.query.empresa;

  if (!esAdmin(req)) {
    empresa = req.session.empresa;
  }

  const tabla = empresa === "Titsa" ? "titsa_maquinas_provisional" : "global_maquinas";

  const r = await pool.query(`
    SELECT DISTINCT ubicacion
    FROM ${tabla}
    WHERE ubicacion IS NOT NULL
    ORDER BY ubicacion
  `);

  res.json(r.rows);
});




app.post("/api/pdfHistorial", requireLogin, async (req, res) => {
  try {
    const { matricula,tipo_vehiculo, fechaInicio, fechaFin, ubicacion} = req.body;

    let where = [];
    let params = [];

    if (!fechaInicio || !fechaFin) {
      return res.status(400).json({ error: "Faltan fechas" });
    }

    if (matricula && matricula.trim() !== "") {
        params.push(matricula.trim());
        where.push(`matricula = $${params.length}`);
    }
    if (tipo_vehiculo && tipo_vehiculo.trim() !== "") {
        params.push(tipo_vehiculo.trim());
        where.push(`tipo_vehiculo = $${params.length}`);
    }    

    if (ubicacion && ubicacion.trim() !== "") {
        params.push(ubicacion.trim());
        where.push(`ubicacion = $${params.length}`);
    }

    if (fechaInicio && fechaFin) {
        params.push(fechaInicio);
        params.push(fechaFin);
        where.push(`fecha_revision::date BETWEEN $${params.length - 1} AND $${params.length}`);
    } else if (fechaInicio) {
        params.push(fechaInicio);
        where.push(`fecha_revision::date >= $${params.length}`);
    } else if (fechaFin) {
        params.push(fechaFin);
        where.push(`fecha_revision::date <= $${params.length}`);
    }

    if (where.length === 0) {
        return res.status(400).json({ error: "Debe indicar vehiculo, fecha o ubicación" });
    }

    const whereSQL = "WHERE " + where.join(" AND ");


    // 🔥 CONSULTA BASE
    let query = `
      SELECT numero_orden,tipo_vehiculo,matricula,ubicacion,indicativo,marca,modelo,fecha_revision,observaciones,operario
      FROM registros_vehiculos
      ${whereSQL}
      ORDER BY fecha_revision DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    // 🔥 ORDEN NECESARIO PARA DISTINCT ON
    query += `
      ORDER BY indicativo, fecha_revision DESC
    `;

    const result = await pool.query(query, params);
    const datos = result.rows;

    if (datos.length === 0) {
      return res.status(404).json({ error: "No hay registros en ese intervalo" });
    }

    // 🔥 AGRUPAR POR UBICACIÓN
    const porUbicacion = {};
    datos.forEach(r => {
      if (!porUbicacion[r.ubicacion]) porUbicacion[r.ubicacion] = [];
      porUbicacion[r.ubicacion].push(r);
    });

    // 🔥 GENERACIÓN DEL PDF (todo igual que antes)
    const PDFDocument = require("pdfkit");
    const doc = new PDFDocument({ margin: 30 });

    let buffers = [];
    doc.on("data", buffers.push.bind(buffers));
    doc.on("end", () => {
      const pdfBuffer = Buffer.concat(buffers);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Historial_Vehiculos_${fechaInicio}_a_${fechaFin}.pdf"`
      );
      res.send(pdfBuffer);
    });

    // -----------------------------
    // ENCABEZADO
    // -----------------------------
    try {
      const imgPath = path.join(process.cwd(), "public", "encabezado.PNG");
      doc.image(imgPath, 30, 15, { width: 320 });
    } catch (err) {
      console.log("Error cargando encabezado:", err);
    }

    doc.font("Helvetica").fontSize(10).fillColor("black");
    doc.text(
      "c/. Tamaduste N5 nave 2 P.I. Majoreras\n" +
      "35259 - Ingenio - Las Palmas\n" +
      "Teléfono - 677 927 340\n" +
      "e-mail  administracion@ayudashidraulicas.com",
      350,
      20
    );

    doc.font("Helvetica-Bold").fontSize(18).text("HISTORIAL DE CORRECCIONES", 0, 85, { align: "center" });

    doc.font("Helvetica").fontSize(12);
    doc.text(`Empresa: ${empresa}`, 30, 130);
    doc.text(`Rango: ${fechaInicio} - ${fechaFin}`, 30, 150);

    let y = 190;

    // -----------------------------
    // FORMATEADOR DE FECHA
    // -----------------------------
    function formatFecha(fecha) {
      if (!fecha) return "";
      const d = new Date(fecha);
      const dia = String(d.getDate()).padStart(2, "0");
      const mes = String(d.getMonth() + 1).padStart(2, "0");
      const ano = d.getFullYear();
      return `${dia}-${mes}-${ano}`;
    }
        // -----------------------------
    // LIMPIEZA DE TEXTO
    // -----------------------------
    function limpiarTexto(txt) {
      if (!txt) return "";
      return txt
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // quitar acentos
        .replace(/[^\x20-\x7E\náéíóúÁÉÍÓÚñÑ.,;:()\-]/g, "") // quitar basura
        .replace(/\s+/g, " ") // colapsar espacios
        .trim();
    }

    // -----------------------------
    // TABLA FLEXIBLE (YA EXISTENTE)
    // -----------------------------
    function addFlexibleRow(doc, y, columns, config = {}) {
      const x = config.x || 30;
      const rowHeight = config.rowHeight || 22;
      const totalWidth = config.totalWidth || 520;

      const totalSpan = columns.reduce((s, col) => s + (col.span || 1), 0);
      const baseWidth = totalWidth / totalSpan;

      let cursorX = x;

      columns.forEach(col => {
        const span = col.span || 1;
        const colWidth = span * baseWidth;

        const labelWidth = colWidth * 0.4;
        const valueWidth = colWidth * 0.6;

        doc.save();
        doc.fillColor("#e6e6e6");
        doc.rect(cursorX, y, labelWidth, rowHeight).fill();
        doc.restore();

        doc.rect(cursorX, y, labelWidth, rowHeight).stroke();
        doc.fontSize(9).text(col.label || "", cursorX + 3, y + 6, {
          width: labelWidth - 6
        });

        doc.rect(cursorX + labelWidth, y, valueWidth, rowHeight).stroke();
        doc.text(col.value || "", cursorX + labelWidth + 3, y + 6, {
          width: valueWidth - 6
        });

        cursorX += colWidth;
      });

      return y + rowHeight;
    }

    // -----------------------------
    // CABECERA FLEXIBLE
    // -----------------------------
    const cfg = {
        Direccion: "c/. Viera y Clavijo 34-36/5ºPlanta",
        Provincia: "Las Palmas",
        CPostal: "35002",
        Ciudad: "Las Palmas de G.C.",
        CIF: "B-35604487",
        Telefono1: "928367301",
        Email: "administracion@ayudashidraulicas.com"
    };

    function drawHeaderWithFlexible(doc, startY, empresa) {
      let y = startY;
      

      const runRow = cols => {
        y = addFlexibleRow(doc, y, cols);
      };

      runRow([{ label: "EMPRESA", value: "consorcio GC" }]);
      runRow([
        { label: "Dirección", value: cfg.Direccion, span: 8 },
        { label: "Provincia", value: cfg.Provincia, span: 4 }
      ]);
      runRow([
        { label: "C. Postal", value: cfg.CPostal, span: 3 },
        { label: "Ciudad", value: cfg.Ciudad, span: 5 },
        { label: "CIF / NIF", value: cfg.CIF, span: 4 }
      ]);
      runRow([
        { label: "Teléfono 1", value: cfg.Telefono1, span: 4 },
        { label: "e-mail", value: cfg.Email, span: 8 }
      ]);
    
      return y;
    }

    y = drawHeaderWithFlexible(doc, y, empresa);
    y += 20;

    // -----------------------------
    // CALCULAR ALTURA DE TABLA
    // -----------------------------
    function calcularAlturaTabla(doc, registros, columnas) {
      let altura = 30;
      altura += 22;

      registros.forEach(r => {
        const heights = columnas.map(c =>
          doc.heightOfString(
            c.key === "fecha_revision"
              ? formatFecha(r.fecha_revision)
              : String(r[c.key] || ""),
            { width: c.width - 6 }
          )
        );
        altura += Math.max(...heights) + 12;
      });

      return altura;
    }

    // -----------------------------
    // DIBUJAR FILA (CORREGIDO)
    // -----------------------------
    function drawRow(doc, y, columnas, r) {
      const heights = columnas.map(c =>
        doc.heightOfString(
          c.key === "fecha_revision"
            ? formatFecha(r.fecha_revision)
            : c.key === "observaciones"
              ? limpiarTexto(r.observaciones)
              : String(r[c.key] || ""),
          { width: c.width - 6 }
        )
      );

      const rowHeight = Math.max(...heights) + 12;

      let x = 30;
      columnas.forEach(c => {
        const texto =
          c.key === "fecha_revision"
            ? formatFecha(r.fecha_revision)
            : c.key === "observaciones"
              ? limpiarTexto(r.observaciones)
              : String(r[c.key] || "");

        doc.rect(x, y, c.width, rowHeight).stroke();
        doc.text(texto, x + 3, y + 6, { width: c.width - 6 });
        x += c.width;
      });

      return y + rowHeight;
    }

    // -----------------------------
    // COLUMNAS
    // -----------------------------
    const columnas = [
      { key: "numero_orden", width: 70 },
      { key: "tipo_vehiculo", width: 100 },
      { key: "matricula", width: 70 },
      { key: "indicativo", width: 70 },
      { key: "ubicacion", width: 80 },
      { key: "fecha_revision", width: 100 },
      { key: "observaciones", width: 120 },
      { key: "operario", width: 70 }
    ];

    // -----------------------------
    // RECORRER UBICACIONES
    // -----------------------------
    for (const ubicacion of Object.keys(porUbicacion)) {
      const registros = porUbicacion[ubicacion];

      const alturaNecesaria = calcularAlturaTabla(doc, registros, columnas);
      const espacioDisponible = doc.page.height - y - 40;
      const mitadPagina = doc.page.height / 2;

      if (alturaNecesaria > espacioDisponible && espacioDisponible < mitadPagina) {
        doc.addPage();
        y = 40;
      }

      doc.font("Helvetica-Bold").fontSize(14);
      doc.text(`UBICACIÓN: ${ubicacion}`, 30, y);
      y += 30;

      let x = 30;
      doc.font("Helvetica-Bold").fontSize(10);
      columnas.forEach(c => {
        doc.rect(x, y, c.width, 22).fill("#e6e6e6").stroke();
        doc.fillColor("black").text(c.key.toUpperCase(), x + 3, y + 6, { width: c.width - 6 });
        x += c.width;
      });
      y += 22;

      doc.font("Helvetica").fontSize(10);

      registros.forEach(r => {
        const heights = columnas.map(c =>
          doc.heightOfString(
            c.key === "fecha_revision"
              ? formatFecha(r.fecha_revision)
              : String(r[c.key] || ""),
            { width: c.width - 6 }
          )
        );

        const rowHeight = Math.max(...heights) + 12;

        if (y + rowHeight > 750) {
          doc.addPage();
          y = 40;

          let x = 30;
          doc.font("Helvetica-Bold").fontSize(10);
          columnas.forEach(c => {
            doc.rect(x, y, c.width, 22).fill("#e6e6e6").stroke();
            doc.fillColor("black").text(c.key.toUpperCase(), x + 3, y + 6, { width: c.width - 6 });
            x += c.width;
          });
          y += 22;
        }

        y = drawRow(doc, y, columnas, r);
      });

      y += 20;
    }
    y += 20;
    doc.font("Helvetica-Bold").fontSize(14);
    const maquinasUnicas = new Set(datos.map(r => r.id_maquina));
    const totalMaquinas = maquinasUnicas.size;
    doc.text(`Total de máquinas: ${totalMaquinas}`, 30, y);
    y += 20;
    doc.text(`Total de registros: ${datos.length}`, 30, y);

    doc.end();

  } catch (err) {
    console.error("ERROR /api/pdfHistorial:", err);
    res.status(500).json({ error: "Error generando PDF" });
  }
});







const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor escuchando en el puerto " + PORT);
});

