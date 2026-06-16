import pg from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const schemaIdentifiers = [
    'Activity', 'Company', 'Container', 'CustomsClearance', 'Document', 'DocumentChecklist',
    'DocumentBundle', 'Expense', 'ExporterCompany', 'Invoice', 'InvoiceItem', 'Logistics', 'Notification',
    'Product', 'SettingOption', 'Shipment', 'ShipmentDocument', 'ShipmentItem', 'TimelineEvent', 'LoginOtp',
    'Transaction', 'User',
    'actionUrl', 'actualArrival', 'allowedFileTypes', 'amountBase', 'assessmentDate',
    'assessmentValue', 'bankAccount', 'bankIfsc', 'bankName', 'billingAddress', 'blNumber',
    'bookingNumber', 'brandName', 'carrierTrackingError', 'carrierTrackingEta',
    'carrierTrackingLastCheckedAt', 'carrierTrackingLastEvent', 'carrierTrackingLocation',
    'carrierTrackingNextCheckAt', 'carrierTrackingRawDetails', 'carrierTrackingStatus', 'codeHash', 'consumedAt',
    'carrierTrackingUrl', 'cbmVolume', 'chaContact', 'chaName', 'checklistId', 'companyType',
    'clearanceDate', 'clearanceStatus', 'companyId', 'contactPerson', 'containerId',
    'containerNumber', 'containerSize', 'containerType', 'countryOfOrigin', 'createdAt',
    'createdBy', 'creditLimit', 'currentLocation', 'currentWeight', 'customsRemarks',
    'deliveryAddress', 'deliveryDate', 'destinationPort', 'dispatchDate', 'documentType',
    'driverName', 'driverPhone', 'dueDate', 'dutyAmount', 'dutyStatus', 'entityId', 'exchangeRate',
    'dedupeKey', 'documentIds', 'emailEnabled', 'emailError', 'emailRecipients', 'emailSentAt',
    'emailStatus', 'expiresAt', 'expiryDate', 'expiryRequired', 'exporterCompany', 'exporterCompanyId', 'fileSize', 'fileType',
    'fileUrl', 'freightForwarder', 'grossWeight', 'gstNumber', 'hsCode', 'iecCode', 'internalNotes',
    'goodsDescription', 'invoiceId', 'invoiceNumber', 'invoiceType', 'ipAddress', 'isActive', 'isRead', 'isRequired',
    'isVerified', 'issueDate', 'lastLoginAt', 'netWeight', 'officeAddress', 'offloadDate',
    'originCountry', 'originPort', 'packingType', 'paidAmount', 'panNumber', 'passwordSetAt',
    'passwordSetupExpiresAt', 'passwordSetupTokenHash', 'paymentDate', 'permissions',
    'paymentMethod', 'paymentStatus', 'podStatus', 'productId', 'referenceNumber', 'rejectedReason',
    'routeFrom', 'routeTo', 'sealNumber', 'shipmentDocuments', 'shipmentId', 'shipmentItems',
    'shipmentNumber', 'shipmentStage', 'shipmentValue', 'shippingAddress', 'shippingLine',
    'storageDays', 'stuffingType', 'taxAmount', 'taxRate', 'timelineEvents', 'totalAmount',
    'totalValue',
    'taxNumber', 'bankDetails', 'customFields', 'documentIds', 'transactionDate', 'transportVendor',
    'unitPrice', 'unitType', 'updatedAt', 'uploadedAt', 'notificationUserIds',
    'uploadedBy', 'userId', 'vehicleNumber', 'vendorName', 'verifiedAt', 'vesselName',
    'voyageNumber', 'warehouseEntry', 'warehouseLocation', 'weightCapacity',
].sort((a, b) => b.length - a.length);
const booleanColumns = new Set(['isActive', 'isVerified', 'isRead', 'isRequired', 'expiryRequired']);
const connectionString = (() => {
    if (!process.env.DATABASE_URL)
        return undefined;
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.delete('sslmode');
    return url.toString();
})();
export const pool = new Pool({
    connectionString,
    ssl: process.env.DATABASE_URL?.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
});
const quoteIdentifier = (identifier) => `"${identifier}"`;
const quoteKnownIdentifiers = (sql) => {
    const transformSqlSegment = (segment) => {
        let transformed = segment.replace(/`([^`]+)`/g, '"$1"');
        for (const identifier of schemaIdentifiers) {
            const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            transformed = transformed.replace(new RegExp(`(?<!["])\\b${escaped}\\b(?!")`, 'g'), quoteIdentifier(identifier));
        }
        return transformed.replace(/\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/gi, (_match, alias) => ` AS "${alias}"`);
    };
    return sql
        .split(/('(?:''|[^'])*')/g)
        .map((segment, index) => (index % 2 === 0 ? transformSqlSegment(segment) : segment))
        .join('');
};
const normalizeBooleanLiterals = (sql) => sql
    .replace(/"?(isActive|isVerified|isRead|isRequired|expiryRequired)"?\s*=\s*1\b/g, '"$1" = TRUE')
    .replace(/"?(isActive|isVerified|isRead|isRequired|expiryRequired)"?\s*=\s*0\b/g, '"$1" = FALSE');
const columnListBeforeValues = (sql) => {
    const match = sql.match(/INSERT\s+INTO\s+"?[A-Za-z_][A-Za-z0-9_]*"?\s*\(([\s\S]*?)\)\s*VALUES/i);
    if (!match?.[1])
        return [];
    return match[1].split(',').map((column) => column.trim().replace(/^"|"$/g, ''));
};
const normalizeParam = (value, context, insertColumn) => {
    const directBooleanColumn = [...booleanColumns].some((column) => new RegExp(`"?${column}"?\\s*=\\s*$`, 'i').test(context));
    if (insertColumn && booleanColumns.has(insertColumn))
        return Boolean(value);
    if (directBooleanColumn)
        return Boolean(value);
    return value;
};
const prepareQuery = (sql, params = []) => {
    const insertColumns = columnListBeforeValues(sql);
    let paramIndex = 0;
    const normalizedParams = [];
    const withPlaceholders = sql.replace(/\?/g, (_placeholder, offset) => {
        const insertColumn = insertColumns[paramIndex];
        normalizedParams.push(normalizeParam(params[paramIndex], sql.slice(Math.max(0, offset - 80), offset), insertColumn));
        paramIndex += 1;
        return `$${paramIndex}`;
    });
    return {
        text: normalizeBooleanLiterals(quoteKnownIdentifiers(withPlaceholders)).replace(/\bLIKE\b/g, 'ILIKE'),
        values: normalizedParams,
    };
};
// Helper for type-safe query results
export const db = {
    query: async (sql, params) => {
        const { text, values } = prepareQuery(sql, params);
        const { rows } = await pool.query(text, values);
        return rows;
    },
    execute: async (sql, params) => {
        const { text, values } = prepareQuery(sql, params);
        const result = await pool.query(text, values);
        return result;
    }
};
