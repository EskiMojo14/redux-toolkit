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
} from '@reduxjs/toolkit'
import { promiseFromEntries, promiseTry } from '../utils'

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
    return promiseTry(() => self.localStorage.getItem(key))
  },
  setItem(key, value) {
    return promiseTry(() => self.localStorage.setItem(key, value))
  },
  removeItem(key) {
    return promiseTry(() => self.localStorage.removeItem(key))
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

async function getStoredState(
  reducerPath: string,
  entry: PersistRegistryEntry
) {
  let {
    config: { storage, deserialize },
  } = entry
  if (typeof deserialize === 'undefined') {
    deserialize = JSON.parse
  }

  const stored = storage.getItem(reducerPath)

  return deserialize === false ? stored : deserialize(stored)
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
      hydrate: (
        state,
        action: PayloadAction<Record<string, any> | undefined>
      ) => {
        state.hydrated = true
      },
      reset: () => initialState,
    },
    selectors: {
      selectRegistered: (state) => state.registered,
      selectHydrated: (state) => state.hydrated,
    },
  })

  const { middlewareRegistered, hydrate, reset } = slice.actions

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
          return promiseFromEntries(
            Object.entries(internalRegistry).map(([reducerPath, entry]) => {
              return [reducerPath, getStoredState(reducerPath, entry)]
            })
          ).then((payload) => next(hydrate(payload)))
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

      store.dispatch(hydrate())

      return store
    }

  const persistSlice = <S, A extends Action, SS>(
    {
      reducerPath,
      reducer,
    }: {
      reducerPath: string
      reducer: Reducer<S, A>
    },
    config: PersistConfig<S, SS>
  ): Reducer<S, A> => {
    internalRegistry[reducerPath] = { config }

    return (state, action) => {
      if (hydrate.match(action)) {
        const possibleState = action.payload && action.payload[reducerPath]
        return reducer(possibleState || state, action)
      }
      return reducer(state, action)
    }
  }

  return {
    reducerPath,
    reducer: slice.reducer,
    actions: slice.actions,
    persistSlice,
    enhancer,
  }
}
