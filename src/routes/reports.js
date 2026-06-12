import { Router } from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { db } from '../db.js';

const router = Router();

const reportData = async () => {
  const shipments = await db.query(`
    SELECT s.shipmentNumber, s.blNumber, s.status, s.shippingLine, s.originCountry,
           s.originPort, s.destinationPort, s.eta, s.shipmentValue, s.currency,
           c.name as importer, COALESCE(e.name, s.exporterCompany) as exporter
    FROM Shipment s
    LEFT JOIN Company c ON s.companyId = c.id
    LEFT JOIN ExporterCompany e ON s.exporterCompanyId = e.id
    WHERE s.isActive = 1 ORDER BY s.createdAt DESC
  `);
  const containers = await db.query(`
    SELECT c.containerNumber, c.containerType, c.containerSize, c.status,
           c.currentLocation, c.goodsDescription, s.shipmentNumber
    FROM Container c JOIN Shipment s ON c.shipmentId = s.id
    WHERE c.isActive = 1 ORDER BY c.createdAt DESC
  `);
  return { shipments, containers };
};

router.get('/summary', async (_req, res) => {
  try {
    const [{ totalShipments }] = await db.query('SELECT COUNT(*) as totalShipments FROM Shipment WHERE isActive = 1');
    const [{ totalContainers }] = await db.query('SELECT COUNT(*) as totalContainers FROM Container WHERE isActive = 1');
    const containerStatus = await db.query('SELECT status, COUNT(*) as count FROM Container WHERE isActive = 1 GROUP BY status');
    return res.json({ data: { totalShipments, totalContainers, containerStatus } });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

router.get('/export.xlsx', async (_req, res) => {
  try {
    const data = await reportData();
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'NEXPORT ERP';
    const shipmentSheet = workbook.addWorksheet('Shipments');
    shipmentSheet.columns = [
      ['Shipment', 'shipmentNumber'], ['BL Number', 'blNumber'], ['Status', 'status'],
      ['Shipping Line', 'shippingLine'], ['Importer', 'importer'], ['Exporter', 'exporter'],
      ['Origin Country', 'originCountry'], ['Origin Port', 'originPort'],
      ['Destination Port', 'destinationPort'], ['ETA', 'eta'],
      ['Value', 'shipmentValue'], ['Currency', 'currency'],
    ].map(([header, key]) => ({ header, key, width: 20 }));
    shipmentSheet.addRows(data.shipments);
    shipmentSheet.getRow(1).font = { bold: true };

    const containerSheet = workbook.addWorksheet('Containers');
    containerSheet.columns = [
      ['Container', 'containerNumber'], ['Shipment', 'shipmentNumber'], ['Type', 'containerType'],
      ['Size', 'containerSize'], ['Status', 'status'], ['Location', 'currentLocation'],
      ['Goods', 'goodsDescription'],
    ].map(([header, key]) => ({ header, key, width: 22 }));
    containerSheet.addRows(data.containers);
    containerSheet.getRow(1).font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="nexport-report.xlsx"');
    return res.send(Buffer.from(buffer));
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

router.get('/export.pdf', async (_req, res) => {
  try {
    const data = await reportData();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="nexport-report.pdf"');
    const pdf = new PDFDocument({ margin: 36, size: 'A4' });
    pdf.pipe(res);
    pdf.fontSize(20).text('NEXPORT ERP Report');
    pdf.moveDown().fontSize(11).text(`Total shipments: ${data.shipments.length}`);
    pdf.text(`Total containers: ${data.containers.length}`);
    pdf.moveDown().fontSize(14).text('Shipments');
    for (const shipment of data.shipments) {
      if (pdf.y > 750) pdf.addPage();
      pdf.fontSize(9).text(
        `${shipment.shipmentNumber} | ${shipment.status} | ${shipment.originPort || '-'} -> ${shipment.destinationPort || '-'} | ${shipment.currency} ${shipment.shipmentValue || 0}`
      );
    }
    pdf.end();
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

export default router;
