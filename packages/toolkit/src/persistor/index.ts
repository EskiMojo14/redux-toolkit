import type {
  Reducer,
  Action,
  PayloadAction,
  StoreEnhancer,
  Middleware,
} from '@reduxjs/toolkit'
import {
  isAction,
  applyMiddleware,
  createSlice,
  nanoid,
  SHOULD_AUTOBATCH,
} from '@reduxjs/toolkit'
import { promiseTry } from '../utils'

interface PersistState {
  hydrated: boolean
  registered: boolean | 'conflict'
}

interface PersistorOptions<ReducerPath extends string = 'persistor'> {
  reducerPath?: ReducerPath
}

interface PersistStorage<Serialized> {
  getItem(key: string): Promise<Serialized | null>
  setItem(key: string, value: Serialized): Promise<void>
  removeItem(key: string): Promise<void>
}

/* eslint-disable no-restricted-globals */
export const localStorage: PersistStorage<string> = {
  getItem(key) {
    return promiseTry(() => globalThis.localStorage.getItem(key))
  },
  setItem(key, value) {
    return promiseTry(() => globalThis.localStorage.setItem(key, value))
  },
  removeItem(key) {
    return promiseTry(() => globalThis.localStorage.removeItem(key))
  },
}
/* eslint-enable no-restricted-globals */

interface PersistConfig<State, Serialized> {
  storage: PersistStorage<Serialized>
  serialize?: ((state: State) => Serialized) | false
  deserialize?: ((serialized: Serialized) => State) | false
}

interface PersistRegistryEntry {
  config: PersistConfig<any, any>
}

interface PersistDispatch<ReducerPath extends string> {
  (action: Action<`${ReducerPath}/hydrate`>): Promise<void>
}

async function getStoredState(name: string, entry: PersistRegistryEntry) {
  let {
    config: { storage, deserialize },
  } = entry
  if (typeof deserialize === 'undefined') {
    deserialize = JSON.parse
  }

  const stored = await storage.getItem(name)

  return deserialize === false ? stored : deserialize(stored)
}

async function storeState(
  name: string,
  state: any,
  entry: PersistRegistryEntry
) {
  let {
    config: { storage, serialize },
  } = entry
  if (typeof serialize === 'undefined') {
    serialize = JSON.stringify
  }

  const serialized = serialize === false ? state : serialize(state)

  return storage.setItem(name, serialized)
}

export const createPersistor = <ReducerPath extends string = 'persistor'>({
  reducerPath = 'persistor' as ReducerPath,
}: PersistorOptions<ReducerPath> = {}) => {
  const persistUid = nanoid()

  const internalRegistry: Record<string, PersistRegistryEntry> = {}

  const initialState: PersistState = { hydrated: false, registered: false }
  const slice = createSlice({
    name: reducerPath,
    initialState,
    reducers: {
      middlewareRegistered: (state, { payload }: PayloadAction<string>) => {
        state.registered =
          state.registered === 'conflict' || persistUid !== payload
            ? 'conflict'
            : true
      },
      hydrate: {
        prepare: (name: string, state: any) => ({
          payload: { name, state },
          meta: { [SHOULD_AUTOBATCH]: true },
        }),
        reducer(state, action: PayloadAction<{ name: string; state: any }>) {
          state.hydrated = true
        },
      },
      init() {},
      reset: () => initialState,
    },
    selectors: {
      selectRegistered: (state) => state.registered,
      selectHydrated: (state) => state.hydrated,
    },
  })

  const { middlewareRegistered, hydrate, reset, init } = slice.actions

  const { selectHydrated, selectRegistered } = slice.selectors

  const middleware: Middleware<
    PersistDispatch<ReducerPath>,
    { [K in ReducerPath]: PersistState }
  > = ({ dispatch, getState }) => {
    let initialized = false
    return (next) => (action) => {
      if (!initialized) {
        initialized = true
        dispatch(middlewareRegistered(persistUid))
      }
      if (isAction(action)) {
        if (reset.match(action)) {
          dispatch(middlewareRegistered(persistUid))
        } else if (hydrate.match(action)) {
          return Promise.all(
            Object.entries(internalRegistry).map(async ([name, entry]) => {
              try {
                const state = await getStoredState(name, entry)
                dispatch(hydrate(name, state))
              } catch {
                // eslint-disable-next-line no-empty
              }
            })
          )
        } else if (
          typeof process !== 'undefined' &&
          process.env.NODE_ENV === 'development'
        ) {
          if (
            middlewareRegistered.match(action) &&
            action.payload === persistUid &&
            selectRegistered(getState()) === 'conflict'
          )
            console.error('whoops')
        }
      }
      const result = next(action)
      const newState = getState()
      return result
    }
  }

  const enhancer: StoreEnhancer<{ dispatch: PersistDispatch<ReducerPath> }> =
    (next) => (reducer, preloadedState) => {
      const createStore = applyMiddleware(middleware)(next)
      const store = createStore(reducer, preloadedState)

      store.dispatch(hydrate(reducerPath, undefined))

      return store
    }

  const persistSlice = <S, A extends Action, SS>(
    {
      name,
      reducer,
    }: {
      name: string
      reducer: Reducer<S, A>
    },
    config: PersistConfig<S, SS>
  ): Reducer<S, A> => {
    internalRegistry[name] = { config }

    return (state, action) => {
      let nextState = state
      if (hydrate.match(action) && action.payload.name === name) {
        const possibleState = action.payload.state
        nextState = reducer(possibleState || state, action)
      } else {
        nextState = reducer(state, action)
      }
      if (state !== nextState) {
        storeState(name, nextState, internalRegistry[name])
      }
      return nextState
    }
  }

  return {
    reducerPath,
    reducer: slice.reducer,
    persistSlice,
    enhancer,
  }
}
