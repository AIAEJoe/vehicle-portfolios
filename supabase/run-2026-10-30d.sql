-- NSB Lifetime warranty program: match the descriptions ("Lifetime Warranty - Unlimited Time & Miles").
-- Updates the program saved in Settings: search words, "no mileage limit" in every system's duration, sticker line.
-- Keeps the covered-systems names, %, deductible and program name as they are. Safe to run more than once.
update public.dealerships d
set bg_program = d.bg_program || jsonb_build_object(
  'match', 'lifetime warranty',
  'sticker_line', 'Lifetime Limited Powertrain Warranty – unlimited time & miles while you own it',
  'systems', (select jsonb_agg(s.value || jsonb_build_object('duration',
      'For as long as the original purchaser owns the vehicle, with no mileage limit (not transferable), subject to the maintenance and inspection requirements in the warranty')
      order by s.ordinality)
    from jsonb_array_elements(d.bg_program->'systems') with ordinality as s))
where d.slug = 'nsbchevy' and d.bg_program is not null;
