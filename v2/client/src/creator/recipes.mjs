// Today's furnish recipes (L2's `tools/god-skill/recipes/furnish/*.json`, furnish/1), by style: imported one by one so
// the served client carries them (`served/build.mjs` follows relative imports).
import apartmentBlock from '../../../../tools/god-skill/recipes/furnish/apartment-block.json' with { type: 'json' };
import bank from '../../../../tools/god-skill/recipes/furnish/bank.json' with { type: 'json' };
import bar from '../../../../tools/god-skill/recipes/furnish/bar.json' with { type: 'json' };
import barn from '../../../../tools/god-skill/recipes/furnish/barn.json' with { type: 'json' };
import cabin from '../../../../tools/god-skill/recipes/furnish/cabin.json' with { type: 'json' };
import cafe from '../../../../tools/god-skill/recipes/furnish/cafe.json' with { type: 'json' };
import chapel from '../../../../tools/god-skill/recipes/furnish/chapel.json' with { type: 'json' };
import church from '../../../../tools/god-skill/recipes/furnish/church.json' with { type: 'json' };
import cornerShop from '../../../../tools/god-skill/recipes/furnish/corner-shop.json' with { type: 'json' };
import cottage from '../../../../tools/god-skill/recipes/furnish/cottage.json' with { type: 'json' };
import courtyardEntry from '../../../../tools/god-skill/recipes/furnish/courtyard-entry.json' with { type: 'json' };
import dormitory from '../../../../tools/god-skill/recipes/furnish/dormitory.json' with { type: 'json' };
import fireStation from '../../../../tools/god-skill/recipes/furnish/fire-station.json' with { type: 'json' };
import garage from '../../../../tools/god-skill/recipes/furnish/garage.json' with { type: 'json' };
import greenhouse from '../../../../tools/god-skill/recipes/furnish/greenhouse.json' with { type: 'json' };
import hall from '../../../../tools/god-skill/recipes/furnish/hall.json' with { type: 'json' };
import hospital from '../../../../tools/god-skill/recipes/furnish/hospital.json' with { type: 'json' };
import hotel from '../../../../tools/god-skill/recipes/furnish/hotel.json' with { type: 'json' };
import house from '../../../../tools/god-skill/recipes/furnish/house.json' with { type: 'json' };
import library from '../../../../tools/god-skill/recipes/furnish/library.json' with { type: 'json' };
import mall from '../../../../tools/god-skill/recipes/furnish/mall.json' with { type: 'json' };
import mansion from '../../../../tools/god-skill/recipes/furnish/mansion.json' with { type: 'json' };
import mobileHome from '../../../../tools/god-skill/recipes/furnish/mobile-home.json' with { type: 'json' };
import museum from '../../../../tools/god-skill/recipes/furnish/museum.json' with { type: 'json' };
import officeBlock from '../../../../tools/god-skill/recipes/furnish/office-block.json' with { type: 'json' };
import pavilion from '../../../../tools/god-skill/recipes/furnish/pavilion.json' with { type: 'json' };
import petrolStation from '../../../../tools/god-skill/recipes/furnish/petrol-station.json' with { type: 'json' };
import policeStation from '../../../../tools/god-skill/recipes/furnish/police-station.json' with { type: 'json' };
import prison from '../../../../tools/god-skill/recipes/furnish/prison.json' with { type: 'json' };
import restaurant from '../../../../tools/god-skill/recipes/furnish/restaurant.json' with { type: 'json' };
import school from '../../../../tools/god-skill/recipes/furnish/school.json' with { type: 'json' };
import shed from '../../../../tools/god-skill/recipes/furnish/shed.json' with { type: 'json' };
import shop from '../../../../tools/god-skill/recipes/furnish/shop.json' with { type: 'json' };
import supermarket from '../../../../tools/god-skill/recipes/furnish/supermarket.json' with { type: 'json' };
import theatre from '../../../../tools/god-skill/recipes/furnish/theatre.json' with { type: 'json' };
import tower from '../../../../tools/god-skill/recipes/furnish/tower.json' with { type: 'json' };
import townHall from '../../../../tools/god-skill/recipes/furnish/town-hall.json' with { type: 'json' };
import townhouse from '../../../../tools/god-skill/recipes/furnish/townhouse.json' with { type: 'json' };
import townhouseRow from '../../../../tools/god-skill/recipes/furnish/townhouse-row.json' with { type: 'json' };

/** The recipes by style. */
export const RECIPES = {
  'apartment-block': apartmentBlock,
  'bank': bank,
  'bar': bar,
  'barn': barn,
  'cabin': cabin,
  'cafe': cafe,
  'chapel': chapel,
  'church': church,
  'corner-shop': cornerShop,
  'cottage': cottage,
  'courtyard-entry': courtyardEntry,
  'dormitory': dormitory,
  'fire-station': fireStation,
  'garage': garage,
  'greenhouse': greenhouse,
  'hall': hall,
  'hospital': hospital,
  'hotel': hotel,
  'house': house,
  'library': library,
  'mall': mall,
  'mansion': mansion,
  'mobile-home': mobileHome,
  'museum': museum,
  'office-block': officeBlock,
  'pavilion': pavilion,
  'petrol-station': petrolStation,
  'police-station': policeStation,
  'prison': prison,
  'restaurant': restaurant,
  'school': school,
  'shed': shed,
  'shop': shop,
  'supermarket': supermarket,
  'theatre': theatre,
  'tower': tower,
  'town-hall': townHall,
  'townhouse': townhouse,
  'townhouse-row': townhouseRow,
};
