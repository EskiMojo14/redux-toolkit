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
  configureStore,
  nanoid,
} from '@reduxjs/toolkit'
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query'

const counterSlice = createSlice({
  name: 'counter',
  initialState: { value: 0 },
  reducers: {
    increment: (state) => void state.value++,
  },
})

type PersistState = {
  hydrated: boolean
  registered: boolean | 'conflict'
}

type PersistorOptions<ReducerPath extends string = 'persistor'> = {
  reducerPath?: ReducerPath
}

type PersistConfig = {
  storage: Storage
}

type PersistRegistryEntry = {
  config: PersistConfig
}

type PersistDispatch<ReducerPath extends string> = {}

const createPersistor = <ReducerPath extends string = 'persistor'>({
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
      init: () => {},
      hydrate: (state, action: PayloadAction<Record<string, any>>) => {
        state.hydrated = true
      },
      reset: () => initialState,
    },
    selectors: {
      selectRegistered: (state) => state.registered,
      selectHydrated: (state) => state.hydrated,
    },
  })

  const { middlewareRegistered, init, hydrate, reset } = slice.actions

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
        } else if (
          typeof process !== 'undefined' &&
          process.env.NODE_ENV === 'development' &&
          middlewareRegistered.match(action) &&
          action.payload === persistUid &&
          selectRegistered(getState()) === 'conflict'
        ) {
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

      store.dispatch(init() as any)

      return store
    }

  const persistSlice = <S, A extends Action>(
    {
      reducerPath,
      reducer,
    }: {
      reducerPath: string
      reducer: Reducer<S, A>
    },
    config: PersistConfig
  ): Reducer<S, A> => {
    internalRegistry[reducerPath] = { config }

    return (state, action) => {
      if (hydrate.match(action)) {
        const possibleState = action.payload[reducerPath]
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

const persistor = createPersistor()

const persistedCounter = persistor.persistSlice(counterSlice, {
  storage: localStorage,
})

const api = createApi({
  baseQuery: fetchBaseQuery(),
  endpoints: () => ({}),
  extractRehydrationInfo(action, { reducerPath }) {
    if (persistor.actions.hydrate.match(action)) {
      return action.payload[reducerPath]
    }
  },
})

const store = configureStore({
  reducer: {
    [persistor.reducerPath]: persistor.reducer,
    [api.reducerPath]: api.reducer,
    [counterSlice.reducerPath]: persistedCounter,
  },
  middleware: (gDM) => gDM().concat(api.middleware),
  enhancers: (gDE) => gDE().concat(persistor.enhancer),
})

store.dispatch(counterSlice.actions.increment())

store.dispatch(persistor.actions.middlewareRegistered(''))
