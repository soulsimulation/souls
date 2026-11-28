// Separate component concern; the default full meeting driver and its acceptance remain unchanged.
import { runConferencePage, SLOT_POINT_COMPONENT } from './conference-native-page.mjs';
export { prepare, beforeNavigation } from './conference-native-page.mjs';
export default context => runConferencePage(context, SLOT_POINT_COMPONENT);
