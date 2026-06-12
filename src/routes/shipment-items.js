import { Router } from 'express';
import { createId } from '@paralleldrive/cuid2';
import { db } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const shipmentId = req.query.shipmentId || '';
    const containerId = req.query.containerId || '';
    let where = '1=1';
    const params = [];
    if (shipmentId) {
      where += ' AND si.shipmentId = ?';
      params.push(shipmentId);
    }
    if (containerId) {
      where += ' AND si.containerId = ?';
      params.push(containerId);
    }
    const rows = await db.query(`
      SELECT si.*, p.name as productName, c.containerNumber
      FROM ShipmentItem si
      LEFT JOIN Product p ON si.productId = p.id
      LEFT JOIN Container c ON si.containerId = c.id
      WHERE ${where} ORDER BY si.id
    `, params);
    return res.json({ data: rows });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body;
    if (!body.shipmentId)
      return res.status(400).json({ error: 'shipmentId is required' });
    const id = createId();
    await db.execute(`
      INSERT INTO ShipmentItem (
        id, shipmentId, productId, containerId, description, quantity, unitPrice,
        currency, grossWeight, netWeight, cbmVolume, packingType
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, body.shipmentId, body.productId || null, body.containerId || null,
      body.description || null, body.quantity || 0, body.unitPrice || 0,
      body.currency || 'USD', body.grossWeight || 0, body.netWeight || 0,
      body.cbmVolume || 0, body.packingType || null,
    ]);
    const [item] = await db.query('SELECT * FROM ShipmentItem WHERE id = ?', [id]);
    return res.status(201).json({ data: item });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const fields = [
      'productId', 'containerId', 'description', 'quantity', 'unitPrice',
      'currency', 'grossWeight', 'netWeight', 'cbmVolume', 'packingType',
    ];
    const updates = [];
    const values = [];
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field] === '' ? null : req.body[field]);
      }
    }
    if (updates.length) {
      values.push(req.params.id);
      await db.execute(`UPDATE ShipmentItem SET ${updates.join(', ')} WHERE id = ?`, values);
    }
    const [item] = await db.query('SELECT * FROM ShipmentItem WHERE id = ?', [req.params.id]);
    return res.json({ data: item });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.execute('DELETE FROM ShipmentItem WHERE id = ?', [req.params.id]);
    return res.json({ data: { id: req.params.id, deleted: true } });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

export default router;
