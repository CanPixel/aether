export type CollectionIconId =
  | 'book'
  | 'cube'
  | 'grid'
  | 'spark'
  | 'globe'
  | 'cloud'
  | 'code'
  | 'lab'
  | 'briefcase'
  | 'pin'
  | 'star'
  | 'archive'

export type CollectionIconOption = {
  id: CollectionIconId
  label: string
  keywords: string
}

export const DEFAULT_COLLECTION_ICON: CollectionIconId = 'book'

export const COLLECTION_ICON_OPTIONS: CollectionIconOption[] = [
  { id: 'book', label: 'Library', keywords: 'book library notes reading research' },
  { id: 'cube', label: 'System', keywords: 'cube system architecture product object' },
  { id: 'grid', label: 'Board', keywords: 'grid board matrix planning map' },
  { id: 'spark', label: 'Insight', keywords: 'spark insight ai ideas analysis' },
  { id: 'globe', label: 'Web', keywords: 'globe web sites browser internet' },
  { id: 'cloud', label: 'Cloud', keywords: 'cloud sync remote services infrastructure' },
  { id: 'code', label: 'Code', keywords: 'code engineering repository api technical' },
  { id: 'lab', label: 'Lab', keywords: 'lab science experiment test chemistry' },
  { id: 'briefcase', label: 'Work', keywords: 'work business client company project' },
  { id: 'pin', label: 'Places', keywords: 'pin location travel place map' },
  { id: 'star', label: 'Priority', keywords: 'star favorite priority important' },
  { id: 'archive', label: 'Archive', keywords: 'archive files records storage reference' }
]

export function normalizeCollectionIcon(icon?: string): CollectionIconId {
  return COLLECTION_ICON_OPTIONS.find((option) => option.id === icon)?.id ?? DEFAULT_COLLECTION_ICON
}
