export interface BarContent {
  text: string
  images: string[]   // data URLs or file paths
  mentions: string[] // @mention strings e.g. "@A.Yuki"
}

export interface Bar {
  id: string
  name: string
  subtitle: string         // secondary label shown under the name
  icon: string | null      // base64 data URL for the icon image
  color: string
  children: string[]       // ordered child IDs (rendered in row below)
  parentId: string | null
  rowIndex: number         // depth level; 0 = top row
  x: number               // absolute x in canvas layout units
  width: number           // block width
  height: number          // individual block height
  content: BarContent
  collapsed?: boolean   // true = children are hidden
}
