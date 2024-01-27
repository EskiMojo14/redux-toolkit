import type { UnknownAction } from '@reduxjs/toolkit'
import {
  combineSlices,
  configureStore,
  createSlice,
  isAction,
  isAllOf,
} from '@reduxjs/toolkit'
import type { PersistStorage } from '../persistor'
import { createPersistor } from '../persistor'

const storageMap = new Map<string, string>()

const storageStub: PersistStorage<string> = {
  getItem: vi.fn(async (key: string) => storageMap.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => {
    storageMap.set(key, value)
  }),
  removeItem: vi.fn(async (key: string) => {
    storageMap.delete(key)
  }),
}

const persistConfig = {
  storage: storageStub,
}

const counterSlice = createSlice({
  name: 'counter',
  initialState: 0,
  reducers: {
    increment: (state) => state + 1,
  },
})
const counterSlice2 = createSlice({
  name: 'counter2',
  initialState: { value: 0 },
  reducers: {
    increment(state) {
      state.value += 1
    },
  },
})

const actionsSlice = createSlice({
  name: 'actions',
  initialState: [] as UnknownAction[],
  reducers: {},
  extraReducers: (builder) => {
    builder.addDefaultCase((state, action) => {
      state.push(action)
    })
  },
})

const nestedSlice = combineSlices(counterSlice, counterSlice2, actionsSlice)

const hasType = (type: string) => (action: UnknownAction) =>
  action.type === type

describe('Persistor idea', () => {
  it('test', async () => {
    const persistor = createPersistor()
    persistor.persistSlice(counterSlice, persistConfig)
    await storageStub.setItem('counter', '1')
    const store = configureStore({
      reducer: combineSlices(counterSlice, persistor, actionsSlice),
      enhancers: (getDefaultEnhancers) =>
        getDefaultEnhancers().concat(persistor.enhancer),
    })

    expect(store.getState().persistor.registered).toBe(true)
  })
})
