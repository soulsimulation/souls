/** The approval card's line when the directory did not keep the name the person gave the new Soul (first day, 28 Nov):
 *  another Soul in this world has it (directoryd `set_profile` refuses `name-taken`), or it is not a name the world
 *  takes (`name`). The Soul arrives either way; its agent can name it with `profile name`. */
export function nameRefusedLine(refused: string | null | undefined): string {
  if (refused === 'name-taken') return 'That name is taken in this world; its agent can choose another.';
  if (refused === 'name') return 'That is not a name this world takes; its agent can choose another.';
  return 'The name was not kept; its agent can set one.';
}
