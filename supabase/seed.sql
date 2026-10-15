-- Seed: New Smyrna Beach Chevrolet + the 2018 Jeep Wrangler from the prototype packet.
-- Safe to run more than once.

insert into public.dealerships (slug, name, phone, sms_phone, website, address_line, city, state, zip, hours,
                                logo_url, brand_primary, brand_accent, default_fees_note)
values ('nsbchevy', 'New Smyrna Beach Chevrolet', '(386) 427-1313', '(386) 427-1313',
        'https://www.newsmyrnachevy.com', '2375 State Road 44', 'New Smyrna Beach', 'FL', '32168',
        'Mon to Sat 9am to 8pm, Sun 11am to 6pm',
        '/seed/nsb-logo.png', '#013C9E', '#F4BC00',
        'Plus $399 computerized vehicle registration fee and $998 documentation fee.')
on conflict (slug) do nothing;

insert into public.staff (dealership_id, full_name, title, phone, photo_url)
select d.id, 'Kyleigh Johnson', 'Sales Consultant', '(386) 427-1313', '/seed/kyleigh-johnson.jpg'
from public.dealerships d
where d.slug = 'nsbchevy'
  and not exists (select 1 from public.staff s where s.dealership_id = d.id and s.full_name = 'Kyleigh Johnson');

insert into public.vehicles (dealership_id, status, condition, stock_number, vin, year, make, model, trim,
  body_style, exterior_color, interior_color, engine, transmission, drivetrain, fuel_type, mileage,
  price, price_label, fees_note, listing_url, salesperson_id, features, created_by)
select d.id, 'published', 'used', 'R287418B', '1C4GJXAG5JW150863', 2018, 'Jeep', 'Wrangler', 'Sport S',
  'SUV', 'Black Clearcoat', 'Black Cloth', '3.6L V6 24V VVT UPG I w/ESS', '8-Speed Automatic',
  'Four Wheel Drive', 'Gasoline', 81273, 17800, 'Live Market Price',
  'Plus $399 computerized vehicle registration fee and $998 documentation fee. Final price: $19,197.',
  'https://www.newsmyrnachevy.com/inventory/used-2018-jeep-wrangler-sport-s-four-wheel-drive-suv-1c4gjxag5jw150863/',
  (select s.id from public.staff s where s.dealership_id = d.id and s.full_name = 'Kyleigh Johnson' limit 1),
  array['Four Wheel Drive', '3.6L V6', '8-Speed Automatic'], null
from public.dealerships d
where d.slug = 'nsbchevy'
on conflict (dealership_id, vin) do nothing;

insert into public.vehicle_photos (vehicle_id, dealership_id, url, position, source)
select v.id, v.dealership_id, format('/seed/jeep-%s.jpg', lpad(n::text, 2, '0')), n - 1, 'url'
from public.vehicles v cross join generate_series(1, 32) n
where v.vin = '1C4GJXAG5JW150863'
  and not exists (select 1 from public.vehicle_photos p where p.vehicle_id = v.id);
