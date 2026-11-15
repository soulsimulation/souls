/** The signed-in account's picture, one component for the world navbar and the homepage: the provider's image
 * (Clerk `imageUrl`) when the account has one; the initial only when it has none. */
export function AccountPicture({avatarUrl,label}:{avatarUrl?:string|null;label:string|null}){
 return avatarUrl?<img src={avatarUrl} alt="" referrerPolicy="no-referrer"/>:<span aria-hidden="true">{label?.replace(/^dev:/,'').trim()[0]?.toUpperCase()??'●'}</span>;
}
