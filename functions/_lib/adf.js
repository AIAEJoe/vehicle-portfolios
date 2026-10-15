// ADF/XML 1.0 lead format, accepted by Elead, VinSolutions, DealerSocket, CDK, etc.
// The CRM's lead-intake mailbox parses the XML from the plain-text email body.

function x(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length < 2) return { first: parts[0] || '', last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

export function buildAdf({ lead, vehicle, dealership, staff, portfolioUrl, now = new Date() }) {
  const { first, last } = splitName(lead.name);
  const comments = [
    lead.kind === 'test_drive' ? 'Test drive request from Vehicle Portfolio.' : 'Question from Vehicle Portfolio.',
    lead.preferred_date ? `Preferred date: ${lead.preferred_date}${lead.preferred_time ? ' (' + lead.preferred_time + ')' : ''}.` : '',
    staff ? `Salesperson: ${staff.full_name}.` : '',
    lead.message ? `Customer notes: ${lead.message}` : '',
    portfolioUrl ? `Portfolio: ${portfolioUrl}` : '',
  ].filter(Boolean).join(' ');

  const vehicleXml = vehicle
    ? `
    <vehicle interest="buy" status="${vehicle.condition === 'new' ? 'new' : 'used'}">
      <year>${x(vehicle.year)}</year>
      <make>${x(vehicle.make)}</make>
      <model>${x(vehicle.model)}</model>${vehicle.trim ? `
      <trim>${x(vehicle.trim)}</trim>` : ''}${vehicle.vin ? `
      <vin>${x(vehicle.vin)}</vin>` : ''}${vehicle.stock_number ? `
      <stock>${x(vehicle.stock_number)}</stock>` : ''}${vehicle.mileage != null ? `
      <odometer status="original" units="mi">${x(vehicle.mileage)}</odometer>` : ''}${vehicle.exterior_color ? `
      <colorcombination><exteriorcolor>${x(vehicle.exterior_color)}</exteriorcolor>${vehicle.interior_color ? `<interiorcolor>${x(vehicle.interior_color)}</interiorcolor>` : ''}<preference>1</preference></colorcombination>` : ''}${vehicle.price != null ? `
      <price type="asking" currency="USD">${x(Math.round(vehicle.price))}</price>` : ''}
    </vehicle>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
  <prospect status="new">
    <id sequence="1" source="Vehicle Portfolios">${x(lead.id || '')}</id>
    <requestdate>${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}</requestdate>${vehicleXml}
    <customer>
      <contact>
        <name part="first">${x(first)}</name>
        <name part="last">${x(last)}</name>${lead.email ? `
        <email>${x(lead.email)}</email>` : ''}${lead.phone ? `
        <phone type="voice" time="nopreference">${x(lead.phone)}</phone>` : ''}
      </contact>
      <comments>${x(comments)}</comments>
    </customer>
    <vendor>
      <vendorname>${x(dealership.name)}</vendorname>${staff ? `
      <contact primarycontact="1"><name part="full">${x(staff.full_name)}</name>${staff.email ? `<email>${x(staff.email)}</email>` : ''}</contact>` : ''}
    </vendor>
    <provider>
      <name part="full">Vehicle Portfolios</name>
      <service>${lead.kind === 'test_drive' ? 'Test Drive Request' : 'Vehicle Inquiry'}</service>${portfolioUrl ? `
      <url>${x(portfolioUrl)}</url>` : ''}
    </provider>
  </prospect>
</adf>
`;
}
